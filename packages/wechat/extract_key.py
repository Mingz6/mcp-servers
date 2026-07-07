#!/usr/bin/env python3
from __future__ import annotations

"""Extract WeChat SQLCipher keys from process memory using macOS Mach VM API.

WCDB caches raw key in process memory as: x'<64hex_enc_key><32hex_salt>'
We search for the DB salt in memory to locate the key.

Usage: sudo python3 extract_key.py
"""

import ctypes
import ctypes.util
import struct
import os
import sys
import hashlib
import hmac as hmac_mod
import re
import time
import glob
import json
import subprocess

KERN_SUCCESS = 0
VM_PROT_READ = 1
VM_PROT_WRITE = 2
VM_PROT_EXECUTE = 4
VM_REGION_BASIC_INFO_64 = 9
VM_REGION_BASIC_INFO_COUNT_64 = 9
PAGE_SZ = 4096
KEY_SZ = 32
SALT_SZ = 16
CHUNK_SZ = 2 * 1024 * 1024
CHUNK_OVERLAP = 128

mach_port_t = ctypes.c_uint32
mach_vm_address_t = ctypes.c_uint64
mach_vm_size_t = ctypes.c_uint64
vm_prot_t = ctypes.c_int32
mach_msg_type_number_t = ctypes.c_uint32


class vm_region_basic_info_64(ctypes.Structure):
    _fields_ = [
        ("protection", vm_prot_t),
        ("max_protection", vm_prot_t),
        ("inheritance", ctypes.c_uint32),
        ("shared", ctypes.c_uint32),
        ("reserved", ctypes.c_uint32),
        ("offset", ctypes.c_uint64),
        ("behavior", ctypes.c_int32),
        ("user_wired_count", ctypes.c_uint16),
    ]


libc = ctypes.CDLL(ctypes.util.find_library("c"))


def list_wechat_processes() -> list[tuple[int, str, int]]:
    result = subprocess.run(
        ["ps", "-axo", "pid=,rss=,comm="],
        capture_output=True,
        text=True,
        check=True,
    )

    candidates: list[tuple[int, str, int]] = []
    for line in result.stdout.splitlines():
        parts = line.strip().split(None, 2)
        if len(parts) != 3:
            continue
        pid_text, rss_text, command = parts
        name = os.path.basename(command)
        if not name.startswith("WeChat"):
            continue
        try:
            pid = int(pid_text)
            rss = int(rss_text)
        except ValueError:
            continue
        candidates.append((pid, name, rss))

    candidates.sort(key=lambda item: item[2], reverse=True)
    return candidates


def get_task(pid):
    task = mach_port_t()
    self_task = libc.mach_task_self()
    kr = libc.task_for_pid(self_task, ctypes.c_int(pid), ctypes.byref(task))
    if kr != KERN_SUCCESS:
        raise RuntimeError(f"task_for_pid failed (kr={kr})")
    return task.value


def enum_regions(task):
    regions = []
    address = mach_vm_address_t(0)
    size = mach_vm_size_t(0)
    info = vm_region_basic_info_64()
    info_count = mach_msg_type_number_t(VM_REGION_BASIC_INFO_COUNT_64)
    object_name = mach_port_t()
    while True:
        info_count.value = VM_REGION_BASIC_INFO_COUNT_64
        kr = libc.mach_vm_region(
            mach_port_t(task), ctypes.byref(address), ctypes.byref(size),
            VM_REGION_BASIC_INFO_64, ctypes.byref(info),
            ctypes.byref(info_count), ctypes.byref(object_name),
        )
        if kr != KERN_SUCCESS:
            break
        is_readable = bool(info.protection & VM_PROT_READ)
        is_writable = bool(info.protection & VM_PROT_WRITE)
        is_executable = bool(info.protection & VM_PROT_EXECUTE)
        if is_readable and is_writable and not is_executable and 0 < size.value < 500 * 1024 * 1024:
            regions.append((address.value, size.value))
        next_addr = address.value + size.value
        if next_addr <= address.value:
            break
        address.value = next_addr
    return regions


def read_mem(task, addr, sz):
    buf = ctypes.create_string_buffer(sz)
    out_size = mach_vm_size_t(0)
    dest_addr = ctypes.addressof(buf)
    kr = libc.mach_vm_read_overwrite(
        mach_port_t(task), mach_vm_address_t(addr), mach_vm_size_t(sz),
        mach_vm_address_t(dest_addr), ctypes.byref(out_size),
    )
    if kr == KERN_SUCCESS and out_size.value > 0:
        return buf.raw[:out_size.value]
    return None


def iter_region_chunks(task: int, base: int, size: int):
    region_end = base + size
    cursor = base
    tail = b""
    while cursor < region_end:
        read_size = min(CHUNK_SZ, region_end - cursor)
        data = read_mem(task, cursor, read_size)
        if data:
            yield tail + data
            tail = data[-CHUNK_OVERLAP:] if len(data) > CHUNK_OVERLAP else data
        else:
            tail = b""
        cursor += read_size


def verify_key_for_db(enc_key, db_page1):
    """Verify enc_key can decrypt this DB's page 1 via HMAC."""
    salt = db_page1[:SALT_SZ]
    mac_salt = bytes(b ^ 0x3A for b in salt)
    mac_key = hashlib.pbkdf2_hmac("sha512", enc_key, mac_salt, 2, dklen=KEY_SZ)
    hmac_data = db_page1[SALT_SZ:PAGE_SZ - 80 + 16]
    stored_hmac = db_page1[PAGE_SZ - 64:PAGE_SZ]
    h = hmac_mod.new(mac_key, hmac_data, hashlib.sha512)
    h.update(struct.pack('<I', 1))
    return h.digest() == stored_hmac


SALT_SEARCH_RADIUS = 8192


def scan_process_salt_anchor(
    task: int,
    regions: list[tuple[int, int]],
    db_files,
    salt_to_dbs,
    already_found: dict,
):
    """Fallback: search for raw 16-byte DB salts in memory, then test
    every 32-byte window within +/- SALT_SEARCH_RADIUS bytes as a key.

    Covers WeChat 4.1+ where the x'<hex>' string is no longer cached but
    a (key, salt) struct may still live in memory side-by-side.
    """
    raw_salt_to_dbs: dict[bytes, list[tuple]] = {}
    for rel, path, sz, salt_hex, page1 in db_files:
        if salt_hex in already_found:
            continue
        raw_salt_to_dbs.setdefault(bytes.fromhex(salt_hex), []).append(
            (rel, path, sz, salt_hex, page1)
        )

    if not raw_salt_to_dbs:
        return {}, {"salt_hits": 0, "verified_keys": 0}

    key_map: dict[str, str] = {}
    stats = {"salt_hits": 0, "verified_keys": 0}
    observed_offsets: set[int] = set()

    for base, size in regions:
        for data in iter_region_chunks(task, base, size):
            for raw_salt, dbs in list(raw_salt_to_dbs.items()):
                start = 0
                while True:
                    idx = data.find(raw_salt, start)
                    if idx < 0:
                        break
                    stats["salt_hits"] += 1
                    start = idx + 1

                    lo = max(0, idx - SALT_SEARCH_RADIUS)
                    hi = min(len(data), idx + SALT_SEARCH_RADIUS + KEY_SZ)
                    window = data[lo:hi]

                    for off in range(0, len(window) - KEY_SZ + 1):
                        candidate = window[off:off + KEY_SZ]
                        if candidate == raw_salt:
                            continue
                        if candidate[:KEY_SZ // 2] == b"\x00" * (KEY_SZ // 2):
                            continue
                        for rel, path, sz, salt_hex, page1 in dbs:
                            if salt_hex in key_map:
                                continue
                            if verify_key_for_db(candidate, page1):
                                key_map[salt_hex] = candidate.hex()
                                observed_offsets.add(lo + off - idx)
                                stats["verified_keys"] += 1
                                print(
                                    f"  [FOUND via salt anchor] "
                                    f"{', '.join(salt_to_dbs[salt_hex][:3])} "
                                    f"(offset {lo + off - idx:+d})"
                                )
                                break

                    remaining = [s for _, _, _, s, _ in dbs if s not in key_map]
                    if not remaining:
                        raw_salt_to_dbs.pop(raw_salt, None)
                        break

            if not raw_salt_to_dbs:
                if observed_offsets:
                    print(
                        f"  [+] Salt-to-key offsets observed: "
                        f"{sorted(observed_offsets)[:5]}"
                    )
                return key_map, stats

    if observed_offsets:
        print(f"  [+] Salt-to-key offsets observed: {sorted(observed_offsets)[:5]}")
    return key_map, stats


def scan_process(task: int, regions: list[tuple[int, int]], db_files, salt_to_dbs):
    hex_re = re.compile(b"x'([0-9a-fA-F]{64,192})'")
    key_map = {}
    stats = {
        "regions": len(regions),
        "raw_matches": 0,
        "salted_candidates": 0,
        "unsalted_candidates": 0,
        "known_salt_hits": 0,
        "verified_keys": 0,
    }
    observed_salts = set()

    total_bytes = sum(size for _, size in regions)
    scanned_bytes = 0

    for reg_idx, (base, size) in enumerate(regions):
        for data in iter_region_chunks(task, base, size):
            for match in hex_re.finditer(data):
                stats["raw_matches"] += 1
                hex_str = match.group(1).decode()
                hex_len = len(hex_str)

                candidates = []
                if hex_len == 96:
                    stats["salted_candidates"] += 1
                    candidates.append((hex_str[:64], hex_str[64:]))
                elif hex_len == 64:
                    stats["unsalted_candidates"] += 1
                    candidates.append((hex_str, None))
                elif hex_len > 96 and hex_len % 2 == 0:
                    stats["salted_candidates"] += 1
                    candidates.append((hex_str[:64], hex_str[-32:]))

                for enc_key_hex, salt_hex in candidates:
                    if salt_hex and salt_hex in salt_to_dbs:
                        stats["known_salt_hits"] += 1
                        observed_salts.add(salt_hex)
                    enc_key = bytes.fromhex(enc_key_hex)
                    targets = []
                    if salt_hex and salt_hex in salt_to_dbs and salt_hex not in key_map:
                        targets = [
                            (rel, path, sz, salt, page1)
                            for rel, path, sz, salt, page1 in db_files
                            if salt == salt_hex
                        ]
                    elif salt_hex is None:
                        targets = [
                            (rel, path, sz, salt, page1)
                            for rel, path, sz, salt, page1 in db_files
                            if salt not in key_map
                        ]

                    for rel, path, sz, salt, page1 in targets:
                        if verify_key_for_db(enc_key, page1):
                            key_map[salt] = enc_key_hex
                            stats["verified_keys"] += 1
                            print(f"  [FOUND] {', '.join(salt_to_dbs[salt][:3])}")
                            break

                    if len(key_map) == len(salt_to_dbs):
                        return key_map, stats, observed_salts

        scanned_bytes += size
        if (reg_idx + 1) % 200 == 0 and total_bytes:
            progress = scanned_bytes / total_bytes * 100
            print(f"  [{progress:.0f}%] {len(key_map)}/{len(salt_to_dbs)} salts matched")

    return key_map, stats, observed_salts


def _restore_owner(path: str) -> None:
    """Hand the file back to the user who invoked sudo.

    This script must run as root (task_for_pid needs it), so files it
    writes default to root-owned. Without this, every downstream reader
    running as the normal user — refresh-wechat.sh's cat/cp, mcp_server.py's
    _load_keys() — hits 'Permission denied' against a mode-0600 root file.
    """
    sudo_uid = os.environ.get("SUDO_UID")
    sudo_gid = os.environ.get("SUDO_GID")
    if sudo_uid and sudo_gid:
        os.chown(path, int(sudo_uid), int(sudo_gid))


def main():
    print("=" * 60)
    print("  WeChat SQLCipher Key Extractor (macOS)")
    print("=" * 60)

    pattern = os.path.expanduser(
        "~/Library/Containers/com.tencent.xinWeChat/Data/Documents/"
        "xwechat_files/*/db_storage"
    )
    db_dirs = glob.glob(pattern)
    if not db_dirs:
        print("[ERROR] WeChat data directory not found")
        sys.exit(1)

    db_dir = db_dirs[0]
    print(f"[+] DB directory: {db_dir}")

    # Collect encrypted DBs and salts
    db_files = []
    salt_to_dbs = {}
    for root, dirs, files in os.walk(db_dir):
        for f in files:
            if f.endswith('.db') and not f.endswith(('-wal', '-shm')):
                path = os.path.join(root, f)
                rel = os.path.relpath(path, db_dir)
                sz = os.path.getsize(path)
                if sz < PAGE_SZ:
                    continue
                with open(path, 'rb') as fh:
                    page1 = fh.read(PAGE_SZ)
                if page1[:16] == b'SQLite format 3\x00':
                    continue
                salt = page1[:SALT_SZ].hex()
                db_files.append((rel, path, sz, salt, page1))
                if salt not in salt_to_dbs:
                    salt_to_dbs[salt] = []
                salt_to_dbs[salt].append(rel)

    print(f"\n[+] {len(db_files)} encrypted DBs, {len(salt_to_dbs)} unique salts")

    candidates = list_wechat_processes()
    if not candidates:
        print("[ERROR] No WeChat process found")
        sys.exit(1)

    key_map = {}
    stats = None
    t0 = time.time()

    print("\nSearching for cached keys...")
    for pid, process_name, rss in candidates:
        print(f"\n[+] Trying {process_name} PID={pid} ({rss // 1024}MB RSS)")
        try:
            task = get_task(pid)
        except RuntimeError as error:
            print(f"  [SKIP] {error}")
            continue

        regions = enum_regions(task)
        total_mb = sum(size for _, size in regions) / 1024 / 1024
        print(f"  [+] Writable memory: {len(regions)} regions, {total_mb:.0f}MB")

        key_map, stats, observed_salts = scan_process(task, regions, db_files, salt_to_dbs)
        print(
            "  [+] Raw matches={raw_matches}, salted={salted_candidates}, "
            "unsalted={unsalted_candidates}, known_salt_hits={known_salt_hits}, "
            "verified={verified_keys}".format(**stats)
        )
        if observed_salts:
            sample_hits = sorted(observed_salts)[:3]
            print(f"  [+] Candidate salts matching DBs: {sample_hits}")
        if key_map:
            break

        anchor_keys, anchor_stats = scan_process_salt_anchor(
            task, regions, db_files, salt_to_dbs, key_map
        )
        print(
            "  [+] Salt-anchor fallback: salt_hits={salt_hits}, "
            "verified={verified_keys}".format(**anchor_stats)
        )
        if anchor_keys:
            key_map.update(anchor_keys)
            break

    elapsed = time.time() - t0
    print(f"\nScan: {elapsed:.1f}s")

    # Cross-validate missing salts with known keys
    missing = set(salt_to_dbs.keys()) - set(key_map.keys())
    if missing and key_map:
        for salt_hex in list(missing):
            for rel, path, sz, s, page1 in db_files:
                if s == salt_hex:
                    for known_key_hex in key_map.values():
                        if verify_key_for_db(bytes.fromhex(known_key_hex), page1):
                            key_map[salt_hex] = known_key_hex
                            missing.discard(salt_hex)
                            break
                    break

    # Output
    print(f"\n{'=' * 60}")
    print(f"Result: {len(key_map)}/{len(salt_to_dbs)} databases decrypted")

    out_file = "/tmp/wechat_keys.json"
    result = {}
    for rel, path, sz, salt_hex, page1 in db_files:
        if salt_hex in key_map:
            result[rel] = {"enc_key": key_map[salt_hex], "salt": salt_hex, "size_mb": round(sz / 1024 / 1024, 1)}

    with open(out_file, 'w') as f:
        json.dump(result, f, indent=2)
    os.chmod(out_file, 0o600)
    _restore_owner(out_file)
    # Strip macOS xattrs (com.apple.provenance) — otherwise Docker Desktop
    # bind mounts reject the file with EPERM. See packages/wechat/README.md.
    subprocess.run(["xattr", "-c", out_file], check=False)
    print(f"Keys saved to: {out_file}")

    if key_map:
        primary_key = list(key_map.values())[0]
        with open("/tmp/wechat_key.txt", 'w') as f:
            f.write(primary_key)
        os.chmod("/tmp/wechat_key.txt", 0o600)
        _restore_owner("/tmp/wechat_key.txt")
        subprocess.run(["xattr", "-c", "/tmp/wechat_key.txt"], check=False)
        print(f"Primary key: /tmp/wechat_key.txt")

    if missing:
        print(f"\nMissing keys for: {[', '.join(salt_to_dbs[s]) for s in missing]}")


if __name__ == '__main__':
    if os.geteuid() != 0:
        print(f"[!] Run with sudo: sudo python3 {sys.argv[0]}")
        sys.exit(1)
    main()
