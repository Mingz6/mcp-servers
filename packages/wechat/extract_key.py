#!/usr/bin/env python3
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

KERN_SUCCESS = 0
VM_PROT_READ = 1
VM_REGION_BASIC_INFO_64 = 9
VM_REGION_BASIC_INFO_COUNT_64 = 9
PAGE_SZ = 4096
KEY_SZ = 32
SALT_SZ = 16

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


def get_wechat_pid():
    import subprocess
    r = subprocess.run(["pgrep", "-x", "WeChat"], capture_output=True, text=True)
    if r.returncode != 0 or not r.stdout.strip():
        print("[ERROR] WeChat is not running")
        sys.exit(1)
    pids = [int(p) for p in r.stdout.strip().split('\n') if p.strip()]
    best = (pids[0], 0)
    for pid in pids:
        try:
            ps = subprocess.run(["ps", "-o", "rss=", "-p", str(pid)],
                                capture_output=True, text=True)
            rss = int(ps.stdout.strip()) if ps.stdout.strip() else 0
            if rss > best[1]:
                best = (pid, rss)
        except (ValueError, subprocess.SubprocessError):
            pass
    print(f"[+] WeChat PID={best[0]} ({best[1] // 1024}MB RSS)")
    return best[0]


def get_task(pid):
    task = mach_port_t()
    self_task = libc.mach_task_self()
    kr = libc.task_for_pid(self_task, ctypes.c_int(pid), ctypes.byref(task))
    if kr != KERN_SUCCESS:
        print(f"[ERROR] task_for_pid failed (kr={kr})")
        print("  Re-sign WeChat first:")
        print("    sudo codesign --force --deep --sign - /Applications/WeChat.app")
        print("  Then restart WeChat and try again.")
        sys.exit(1)
    print(f"[+] Got task port for PID {pid}")
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
        if (info.protection & VM_PROT_READ) and 0 < size.value < 500 * 1024 * 1024:
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

    pid = get_wechat_pid()
    task = get_task(pid)
    regions = enum_regions(task)
    total_mb = sum(s for _, s in regions) / 1024 / 1024
    print(f"[+] Readable memory: {len(regions)} regions, {total_mb:.0f}MB")

    # Search for x'<hex>' key patterns
    print(f"\nSearching for cached keys...")
    hex_re = re.compile(b"x'([0-9a-fA-F]{64,192})'")
    key_map = {}
    t0 = time.time()

    for reg_idx, (base, size) in enumerate(regions):
        data = read_mem(task, base, size)
        if not data:
            continue
        for m in hex_re.finditer(data):
            hex_str = m.group(1).decode()
            hex_len = len(hex_str)

            candidates = []
            if hex_len == 96:
                candidates.append((hex_str[:64], hex_str[64:]))
            elif hex_len == 64:
                candidates.append((hex_str, None))
            elif hex_len > 96 and hex_len % 2 == 0:
                candidates.append((hex_str[:64], hex_str[-32:]))

            for enc_key_hex, salt_hex in candidates:
                enc_key = bytes.fromhex(enc_key_hex)
                targets = []
                if salt_hex and salt_hex in salt_to_dbs and salt_hex not in key_map:
                    targets = [(rel, path, sz, s, page1) for rel, path, sz, s, page1 in db_files if s == salt_hex]
                elif salt_hex is None:
                    targets = [(rel, path, sz, s, page1) for rel, path, sz, s, page1 in db_files if s not in key_map]

                for rel, path, sz, s, page1 in targets:
                    if verify_key_for_db(enc_key, page1):
                        key_map[s] = enc_key_hex
                        print(f"  [FOUND] {', '.join(salt_to_dbs[s][:3])}")
                        break

        if (reg_idx + 1) % 200 == 0:
            progress = sum(s for b, s in regions[:reg_idx+1]) / sum(s for _, s in regions) * 100
            print(f"  [{progress:.0f}%] {len(key_map)}/{len(salt_to_dbs)} salts matched")

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
    print(f"Keys saved to: {out_file}")

    if key_map:
        primary_key = list(key_map.values())[0]
        with open("/tmp/wechat_key.txt", 'w') as f:
            f.write(primary_key)
        print(f"Primary key: /tmp/wechat_key.txt")

    if missing:
        print(f"\nMissing keys for: {[', '.join(salt_to_dbs[s]) for s in missing]}")


if __name__ == '__main__':
    if os.geteuid() != 0:
        print(f"[!] Run with sudo: sudo python3 {sys.argv[0]}")
        sys.exit(1)
    main()
