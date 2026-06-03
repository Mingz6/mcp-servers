#!/usr/bin/env python3
"""LinkedIn MCP Server — read inbox, conversations, send messages, search people, view profiles.

Uses Patchright (stealth Playwright fork) with persistent browser context.
First run opens a headed browser for manual login. Session is saved and reused.

Architecture inspired by stickerdaniel/linkedin-mcp-server:
- Sequential tool execution via asyncio.Lock (one scrape at a time)
- innerText extraction instead of brittle CSS selectors
- Rate limit detection (hard 429 + soft noise-only pages) with auto-retry
- Content hydration wait before extraction
- LinkedIn noise filtering (footer/sidebar/chrome removal)

Usage:
  .venv/bin/python mcp_server.py
  .venv/bin/python mcp_server.py --login    # Force fresh login
  .venv/bin/python mcp_server.py --logout   # Delete saved session
"""

import argparse
import asyncio
import logging
import os
import re
import shutil
import stat
import sys
from typing import Optional
from urllib.parse import quote_plus

from mcp.server.fastmcp import FastMCP
from patchright.async_api import (
    async_playwright,
    Browser,
    BrowserContext,
    Page,
    Playwright,
    TimeoutError as PlaywrightTimeoutError,
)

logger = logging.getLogger("linkedin-mcp")

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

SESSION_DIR = os.path.expanduser("~/.linkedin-mcp")
USER_DATA_DIR = os.path.join(SESSION_DIR, "browser-data")
LINKEDIN_BASE = "https://www.linkedin.com"
DEFAULT_TIMEOUT = 30_000  # ms for element operations
NAV_TIMEOUT = 45_000  # ms for page navigation
RATE_LIMIT_RETRY_DELAY = 5.0  # seconds between soft-rate-limit retries

# LinkedIn noise — lines matching these appear in sidebar/footer chrome
_NOISE_PATTERNS = re.compile(
    r"^("
    r"About\s*$|Accessibility\s*$|Talent Solutions|Marketing Solutions|"
    r"Sales Solutions|LinkedIn Corporation|Privacy & Terms|"
    r"Ad Choices|Advertising|More$|Business Services|"
    r"Get the LinkedIn app|Sign Up|Join now|"
    r"Messaging|Notifications|My Network|Jobs$|"
    r"Try Premium Free|LinkedIn News|LinkedIn\s*©"
    r")",
    re.IGNORECASE,
)

# ---------------------------------------------------------------------------
# MCP Server
# ---------------------------------------------------------------------------

mcp = FastMCP(
    "linkedin",
    instructions=(
        "Read and send LinkedIn messages, search people, view profiles, create feed posts, "
        "and add comments. "
        "Tools: linkedin_inbox, linkedin_conversation, linkedin_send_message, "
        "linkedin_search_people, linkedin_profile, linkedin_create_post, "
        "linkedin_add_comment, linkedin_login, linkedin_close."
    ),
)

# ---------------------------------------------------------------------------
# Sequential execution lock — prevents parallel tool calls from racing the browser
# ---------------------------------------------------------------------------

_tool_lock = asyncio.Lock()

# ---------------------------------------------------------------------------
# Browser lifecycle (singleton pattern)
# ---------------------------------------------------------------------------

_pw: Optional[Playwright] = None
_context: Optional[BrowserContext] = None
_page: Optional[Page] = None


def _secure_mkdir(path: str) -> None:
    """Create directory with restrictive permissions (owner-only)."""
    os.makedirs(path, exist_ok=True)
    os.chmod(path, stat.S_IRWXU)


async def _get_page() -> Page:
    """Get or create a persistent browser page with saved session."""
    global _pw, _context, _page

    if _page and not _page.is_closed():
        return _page

    _secure_mkdir(SESSION_DIR)
    _secure_mkdir(USER_DATA_DIR)

    _pw = await async_playwright().start()
    _context = await _pw.chromium.launch_persistent_context(
        user_data_dir=USER_DATA_DIR,
        headless=True,
        viewport={"width": 1280, "height": 900},
        locale="en-US",
        args=[
            "--disable-blink-features=AutomationControlled",
            "--disable-notifications",
            "--no-sandbox",
        ],
    )

    if _context.pages:
        _page = _context.pages[0]
    else:
        _page = await _context.new_page()

    _page.set_default_timeout(DEFAULT_TIMEOUT)
    _page.set_default_navigation_timeout(NAV_TIMEOUT)

    return _page


# ---------------------------------------------------------------------------
# Core extraction helpers (innerText-based, inspired by stickerdaniel)
# ---------------------------------------------------------------------------


def _filter_noise(text: str) -> str:
    """Remove LinkedIn sidebar/footer noise lines from extracted text."""
    lines = text.split("\n")
    filtered = []
    for line in lines:
        stripped = line.strip()
        if not stripped:
            # Preserve paragraph breaks (max 1 blank line)
            if filtered and filtered[-1] != "":
                filtered.append("")
            continue
        if _NOISE_PATTERNS.match(stripped):
            continue
        filtered.append(line)
    # Trim trailing blanks
    while filtered and filtered[-1] == "":
        filtered.pop()
    return "\n".join(filtered)


def _truncate_noise_tail(text: str) -> str:
    """Truncate everything after the LinkedIn footer separator.

    LinkedIn pages typically end with a block starting 'LinkedIn © 2025'
    or a cluster of navigation links. Cut at the first footer marker.
    """
    markers = [
        "LinkedIn Corporation ©",
        "LinkedIn © 20",
        "\nAbout\nAccessibility\n",
        "\nUser Agreement\n",
    ]
    best_pos = len(text)
    for marker in markers:
        pos = text.find(marker)
        if pos != -1 and pos < best_pos:
            best_pos = pos
    return text[:best_pos].rstrip()


async def _detect_rate_limit(page: Page) -> None:
    """Raise if LinkedIn shows a hard rate-limit page (HTTP 429 equivalent)."""
    try:
        is_limited = await page.evaluate(
            """() => {
                const body = document.body?.innerText || '';
                return body.includes("you've reached the limit")
                    || body.includes("unusual amount of activity")
                    || body.includes("Too many requests");
            }"""
        )
        if is_limited:
            raise RateLimitError("LinkedIn rate limit detected. Wait before retrying.")
    except PlaywrightTimeoutError:
        pass


async def _detect_auth_barrier(page: Page) -> bool:
    """Check if the current page is an auth wall. Returns True if NOT authenticated."""
    url = page.url
    if any(x in url for x in ["/login", "/authwall", "/checkpoint", "/uas/"]):
        return True
    try:
        is_barrier = await page.evaluate(
            """() => {
                const url = window.location.href;
                return url.includes('/login') || url.includes('/authwall')
                    || url.includes('/checkpoint')
                    || !!document.querySelector('form.login__form');
            }"""
        )
        return bool(is_barrier)
    except Exception:
        return False


async def _wait_for_main_text(
    page: Page, *, minimum_length: int = 100, timeout: int = 10_000
) -> None:
    """Wait for <main> to have enough innerText (content hydration)."""
    try:
        await page.wait_for_function(
            """({ minLen }) => {
                const main = document.querySelector('main');
                if (!main) return false;
                return main.innerText.length > minLen;
            }""",
            arg={"minLen": minimum_length},
            timeout=timeout,
        )
    except PlaywrightTimeoutError:
        logger.debug("Content did not hydrate within %dms", timeout)


async def _dismiss_modals(page: Page) -> None:
    """Dismiss any modal/overlay blocking the page content."""
    try:
        modal_close = page.locator(
            "button[aria-label='Dismiss'], "
            "button[aria-label='Close'], "
            "button.artdeco-modal__dismiss, "
            "button.msg-overlay-bubble-header__control--new-convo-btn"
        ).first
        if await modal_close.is_visible(timeout=1000):
            await modal_close.click(timeout=2000)
            await asyncio.sleep(0.5)
    except (PlaywrightTimeoutError, Exception):
        pass


async def _scroll_to_bottom(page: Page, *, max_scrolls: int = 5, pause: float = 0.8) -> None:
    """Scroll down to trigger lazy-loading content."""
    for _ in range(max_scrolls):
        previous_height = await page.evaluate("document.body.scrollHeight")
        await page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
        await asyncio.sleep(pause)
        new_height = await page.evaluate("document.body.scrollHeight")
        if new_height == previous_height:
            break


async def _extract_main_text(page: Page) -> str:
    """Extract innerText from <main>, falling back to <body>."""
    raw = await page.evaluate(
        """() => {
            const main = document.querySelector('main');
            return (main || document.body).innerText || '';
        }"""
    )
    if not raw:
        return ""
    truncated = _truncate_noise_tail(raw)
    return _filter_noise(truncated)


async def _navigate_and_extract(
    page: Page,
    url: str,
    *,
    min_text: int = 100,
    max_scrolls: int = 5,
) -> str:
    """Navigate → wait for hydration → dismiss modals → scroll → extract.

    Returns cleaned innerText. Retries once on soft rate limit (noise-only page).
    Raises RateLimitError on hard rate limit.
    """
    await page.goto(url, wait_until="domcontentloaded")
    await _detect_rate_limit(page)

    if await _detect_auth_barrier(page):
        raise AuthError("Not logged in. Call linkedin_login first.")

    await _wait_for_main_text(page, minimum_length=min_text)
    await _dismiss_modals(page)
    await _scroll_to_bottom(page, max_scrolls=max_scrolls)

    text = await _extract_main_text(page)

    # Soft rate limit: page loaded but only noise (no real content)
    if not text or len(text) < 50:
        logger.info("Soft rate limit on %s, retrying after %.0fs", url, RATE_LIMIT_RETRY_DELAY)
        await asyncio.sleep(RATE_LIMIT_RETRY_DELAY)
        await page.goto(url, wait_until="domcontentloaded")
        await _detect_rate_limit(page)
        await _wait_for_main_text(page, minimum_length=min_text)
        await _dismiss_modals(page)
        await _scroll_to_bottom(page, max_scrolls=max_scrolls)
        text = await _extract_main_text(page)

    return text


# ---------------------------------------------------------------------------
# Custom exceptions
# ---------------------------------------------------------------------------


class RateLimitError(Exception):
    pass


class AuthError(Exception):
    pass


# ---------------------------------------------------------------------------
# Auth helpers
# ---------------------------------------------------------------------------


async def _ensure_logged_in(page: Page) -> bool:
    """Navigate to /feed/ and check if we're authenticated."""
    try:
        await page.goto(f"{LINKEDIN_BASE}/feed/", wait_until="domcontentloaded")
        await asyncio.sleep(2)
        return not await _detect_auth_barrier(page)
    except Exception:
        return False


async def _headed_login() -> str:
    """Open a headed browser for manual login. Blocks until user completes login."""
    global _pw, _context, _page

    if _context:
        await _context.close()
        _context = None
        _page = None

    _pw = await async_playwright().start()
    _context = await _pw.chromium.launch_persistent_context(
        user_data_dir=USER_DATA_DIR,
        headless=False,
        viewport={"width": 1280, "height": 900},
        locale="en-US",
        args=[
            "--disable-blink-features=AutomationControlled",
            "--disable-notifications",
            "--no-sandbox",
        ],
    )

    if _context.pages:
        _page = _context.pages[0]
    else:
        _page = await _context.new_page()

    _page.set_default_timeout(120_000)
    _page.set_default_navigation_timeout(120_000)

    await _page.goto(f"{LINKEDIN_BASE}/login", wait_until="domcontentloaded")

    try:
        await _page.wait_for_url("**/feed/**", timeout=120_000)
    except Exception:
        if "/login" in _page.url or "/authwall" in _page.url:
            return "Login timed out. Please try again with linkedin_login."

    # Close and reopen headless next time _get_page() is called
    await _context.close()
    _context = None
    _page = None

    return "Login successful. Session saved."


# ---------------------------------------------------------------------------
# MCP Tools
# ---------------------------------------------------------------------------


@mcp.tool()
async def linkedin_login() -> str:
    """Open a browser window for LinkedIn login.

    This opens a visible browser — log in manually (including 2FA if needed).
    The session is saved and reused for all subsequent calls.
    Call this if other tools report 'not logged in'.
    """
    return await _headed_login()


@mcp.tool()
async def linkedin_inbox(limit: int = 15) -> str:
    """List recent LinkedIn message conversations.

    Args:
        limit: Max conversations to return (default 15, max 30)
    """
    limit = min(max(1, limit), 30)

    async with _tool_lock:
        page = await _get_page()

        if not await _ensure_logged_in(page):
            return "Not logged in. Call linkedin_login first."

        text = await _navigate_and_extract(
            page,
            f"{LINKEDIN_BASE}/messaging/",
            min_text=50,
            max_scrolls=3,
        )

        if not text:
            return "Could not load messaging inbox."

        # Also extract thread IDs from the page for reference
        thread_ids = await page.evaluate(
            """() => {
                const links = document.querySelectorAll('a[href*="/messaging/thread/"]');
                return [...links].map(a => {
                    const match = a.href.match(/\\/messaging\\/thread\\/([^/]+)/);
                    return match ? match[1] : null;
                }).filter(Boolean);
            }"""
        )

        result = f"LinkedIn Inbox:\n\n{text}"
        if thread_ids:
            unique_ids = list(dict.fromkeys(thread_ids))[:limit]
            result += f"\n\n---\nThread IDs (use with linkedin_conversation): {', '.join(unique_ids[:10])}"

        return result


@mcp.tool()
async def linkedin_conversation(
    thread_id: str = "",
    name: str = "",
    limit: int = 20,
) -> str:
    """Read messages in a LinkedIn conversation.

    Provide either thread_id (from linkedin_inbox) or name (partial match).

    Args:
        thread_id: Thread ID from inbox listing (preferred)
        name: Person's name to search for in conversations
        limit: Max messages to return (default 20, max 50)
    """
    if not thread_id and not name:
        return "Provide either thread_id or name to identify the conversation."

    limit = min(max(1, limit), 50)

    async with _tool_lock:
        page = await _get_page()

        if not await _ensure_logged_in(page):
            return "Not logged in. Call linkedin_login first."

        if thread_id:
            text = await _navigate_and_extract(
                page,
                f"{LINKEDIN_BASE}/messaging/thread/{thread_id}/",
                min_text=30,
                max_scrolls=2,
            )
        else:
            # Navigate to messaging and use search
            await page.goto(f"{LINKEDIN_BASE}/messaging/", wait_until="domcontentloaded")
            await _wait_for_main_text(page, minimum_length=50)

            try:
                search_input = await page.wait_for_selector(
                    "input[placeholder*='Search messages'], "
                    "input.msg-search-form__search-field",
                    timeout=10_000,
                )
                if search_input:
                    await search_input.fill(name)
                    await page.keyboard.press("Enter")
                    await asyncio.sleep(3)

                    first_result = await page.query_selector(
                        "li.msg-conversation-listitem"
                    )
                    if first_result:
                        await first_result.click()
                        await asyncio.sleep(2)
                    else:
                        return f"No conversation found matching '{name}'."
            except Exception:
                return f"Could not search for conversation with '{name}'."

            await _wait_for_main_text(page, minimum_length=30)
            text = await _extract_main_text(page)

        if not text:
            return "No messages found in this conversation."

        return f"Conversation ({thread_id or name}):\n\n{text}"


@mcp.tool()
async def linkedin_send_message(
    thread_id: str = "",
    name: str = "",
    text: str = "",
    confirm_send: bool = False,
) -> str:
    """Send a message in a LinkedIn conversation.

    IMPORTANT: Always confirm the message content with the user before calling.
    Set confirm_send=True to actually send. Without it, this is a dry run.

    Args:
        thread_id: Thread ID (from linkedin_inbox)
        name: Person's name (alternative to thread_id)
        text: Message text to send
        confirm_send: Must be True to actually send. False = dry run.
    """
    if not text.strip():
        return "Cannot send empty message."
    if not thread_id and not name:
        return "Provide either thread_id or name."

    if not confirm_send:
        target = thread_id or name
        return (
            f"DRY RUN — would send to '{target}':\n\n"
            f"{text}\n\n"
            f"Call again with confirm_send=True to actually send."
        )

    async with _tool_lock:
        page = await _get_page()

        if not await _ensure_logged_in(page):
            return "Not logged in. Call linkedin_login first."

        if thread_id:
            await page.goto(
                f"{LINKEDIN_BASE}/messaging/thread/{thread_id}/",
                wait_until="domcontentloaded",
            )
        else:
            await page.goto(f"{LINKEDIN_BASE}/messaging/", wait_until="domcontentloaded")
            await _wait_for_main_text(page, minimum_length=50)
            try:
                search_input = await page.wait_for_selector(
                    "input[placeholder*='Search messages'], "
                    "input.msg-search-form__search-field",
                    timeout=10_000,
                )
                if search_input:
                    await search_input.fill(name)
                    await page.keyboard.press("Enter")
                    await asyncio.sleep(3)

                    first_result = await page.query_selector(
                        "li.msg-conversation-listitem"
                    )
                    if first_result:
                        await first_result.click()
                        await asyncio.sleep(2)
                    else:
                        return f"No conversation found matching '{name}'."
            except Exception:
                return f"Could not navigate to conversation with '{name}'."

        await _wait_for_main_text(page, minimum_length=30)
        await _dismiss_modals(page)

        try:
            msg_input = await page.wait_for_selector(
                "div.msg-form__contenteditable, "
                "div[role='textbox'][contenteditable='true']",
                timeout=10_000,
            )
            if not msg_input:
                return "Could not find message input field."

            await msg_input.click()
            await msg_input.fill(text)
            await asyncio.sleep(0.5)

            send_btn = await page.query_selector(
                "button.msg-form__send-button, "
                "button[type='submit'].msg-form__send-btn"
            )
            if send_btn:
                await send_btn.click()
            else:
                await page.keyboard.press("Enter")

            await asyncio.sleep(2)

            target = name or thread_id
            return f"Message sent to {target}."
        except Exception as e:
            return f"Failed to send message: {e}"


@mcp.tool()
async def linkedin_search_people(
    query: str,
    limit: int = 10,
) -> str:
    """Search LinkedIn for people by keyword.

    Args:
        query: Search keywords (name, title, company, etc.)
        limit: Max results (default 10, max 20)
    """
    if not query.strip():
        return "Search query required."

    limit = min(max(1, limit), 20)

    async with _tool_lock:
        page = await _get_page()

        if not await _ensure_logged_in(page):
            return "Not logged in. Call linkedin_login first."

        search_url = (
            f"{LINKEDIN_BASE}/search/results/people/"
            f"?keywords={quote_plus(query)}"
        )

        text = await _navigate_and_extract(page, search_url, min_text=80, max_scrolls=3)

        if not text:
            return f"No results found for '{query}' or page failed to load."

        # Also extract profile links for structured output
        profile_links = await page.evaluate(
            """() => {
                const links = document.querySelectorAll('a[href*="/in/"]');
                const seen = new Set();
                const results = [];
                for (const a of links) {
                    const match = a.href.match(/\\/in\\/([^/?]+)/);
                    if (!match || seen.has(match[1])) continue;
                    seen.add(match[1]);
                    const name = a.querySelector('span[aria-hidden="true"]');
                    results.push({
                        username: match[1],
                        name: name ? name.innerText.trim() : match[1]
                    });
                }
                return results;
            }"""
        )

        result = f"People matching '{query}':\n\n{text}"
        if profile_links:
            result += "\n\n---\nProfile usernames: "
            result += ", ".join(p["username"] for p in profile_links[:limit])

        return result


@mcp.tool()
async def linkedin_profile(username: str) -> str:
    """View a LinkedIn profile by username.

    Args:
        username: LinkedIn username (the part after /in/ in the URL)
    """
    if not username.strip():
        return "Username required (e.g., 'johndoe' from linkedin.com/in/johndoe)."

    username = re.sub(r".*linkedin\.com/in/", "", username).strip("/")

    async with _tool_lock:
        page = await _get_page()

        if not await _ensure_logged_in(page):
            return "Not logged in. Call linkedin_login first."

        url = f"{LINKEDIN_BASE}/in/{username}/"

        try:
            text = await _navigate_and_extract(page, url, min_text=80, max_scrolls=4)
        except AuthError as e:
            return str(e)
        except RateLimitError as e:
            return f"Rate limited. Wait a few minutes and try again."

        # Check for 404
        if "404" in (await page.title()) or "/404" in page.url:
            return f"Profile not found: {username}"

        if not text:
            return f"Could not load profile for {username}."

        return f"LinkedIn Profile: {LINKEDIN_BASE}/in/{username}/\n\n{text}"


@mcp.tool()
async def linkedin_create_post(
    text: str,
    visibility: str = "ANYONE",
    confirm_post: bool = False,
) -> str:
    """Create a new LinkedIn feed post via API.

    IMPORTANT: Always show the post content to the user before calling with confirm_post=True.
    Set confirm_post=True to actually publish. Without it, this is a dry run.

    Args:
        text: Post text content
        visibility: Who can see the post - "ANYONE" (public) or "CONNECTIONS"
        confirm_post: Must be True to actually publish. False = dry run.
    """
    if not text.strip():
        return "Cannot post empty text."

    if not confirm_post:
        preview = f"DRY RUN — would post to LinkedIn feed:\n\n{text}"
        preview += f"\n\nVisibility: {visibility}"
        preview += "\n\nCall again with confirm_post=True to publish."
        return preview

    if visibility not in ("ANYONE", "CONNECTIONS"):
        return "visibility must be 'ANYONE' or 'CONNECTIONS'."

    async with _tool_lock:
        page = await _get_page()

        if not await _ensure_logged_in(page):
            return "Not logged in. Call linkedin_login first."

        await page.goto(f"{LINKEDIN_BASE}/feed/", wait_until="domcontentloaded")
        await _wait_for_main_text(page, minimum_length=50)

        try:
            result = await page.evaluate(
                """async ([postText, vis]) => {
                    const csrfToken = document.cookie.match(/JSESSIONID="?([^";]+)/)?.[1] || '';
                    if (!csrfToken) return {ok: false, error: 'No CSRF token found'};

                    const queryId = 'voyagerContentcreationDashShares.279996efa5064c01775d5aff003d9377';
                    const payload = {
                        variables: {
                            post: {
                                allowedCommentersScope: 'ALL',
                                intendedShareLifeCycleState: 'PUBLISHED',
                                origin: 'FEED',
                                visibilityDataUnion: { visibilityType: vis },
                                commentary: { text: postText, attributesV2: [] }
                            }
                        },
                        queryId: queryId,
                        includeWebMetadata: true
                    };

                    const resp = await fetch('/voyager/api/graphql?action=execute&queryId=' + queryId, {
                        method: 'POST',
                        headers: {
                            'csrf-token': csrfToken,
                            'Content-Type': 'application/json; charset=UTF-8',
                            'x-restli-protocol-version': '2.0.0',
                            'x-li-lang': 'en_US',
                            'accept': 'application/vnd.linkedin.normalized+json+2.1',
                        },
                        body: JSON.stringify(payload)
                    });

                    const body = await resp.text();
                    if (resp.status === 200) {
                        try {
                            const data = JSON.parse(body);
                            const key = data?.data?.data?.createContentcreationDashShares?.resourceKey || '';
                            return {ok: true, urn: key};
                        } catch(e) {
                            return {ok: true, urn: ''};
                        }
                    }
                    return {ok: false, error: resp.status + ': ' + body.substring(0, 300)};
                }""",
                [text, visibility],
            )

            if result.get("ok"):
                urn = result.get("urn", "")
                msg = "Post published to LinkedIn feed successfully."
                if urn:
                    post_url = f"{LINKEDIN_BASE}/feed/update/{urn}"
                    msg += f"\n{post_url}"
                return msg
            else:
                return f"Failed to create post: {result.get('error', 'Unknown error')}"

        except Exception as e:
            return f"Failed to create post: {e}"


@mcp.tool()
async def linkedin_add_comment(
    activity_urn: str,
    text: str,
    confirm_comment: bool = False,
) -> str:
    """Add a comment to a LinkedIn post via browser automation.

    LinkedIn's SDUI architecture requires browser-driven submission for comments.

    Args:
        activity_urn: The activity URN (e.g. "urn:li:activity:1234567890123456789")
                      or just the activity ID number.
        text: Comment text to post.
        confirm_comment: Must be True to actually post. False = dry run.
    """
    if not text.strip():
        return "Cannot post empty comment."

    # Normalize activity URN
    urn = activity_urn.strip()
    if urn.isdigit():
        urn = f"urn:li:activity:{urn}"
    if not urn.startswith("urn:li:activity:"):
        return "activity_urn must be 'urn:li:activity:{id}' or a numeric activity ID."

    if not confirm_comment:
        preview = f"DRY RUN — would comment on {urn}:\n\n{text}"
        preview += "\n\nCall again with confirm_comment=True to post."
        return preview

    async with _tool_lock:
        page = await _get_page()

        if not await _ensure_logged_in(page):
            return "Not logged in. Call linkedin_login first."

        post_url = f"{LINKEDIN_BASE}/feed/update/{urn}/"
        await page.goto(post_url, wait_until="domcontentloaded")
        await asyncio.sleep(4)

        # Check post loaded
        if "404" in (await page.title()) or "/404" in page.url:
            return f"Post not found: {urn}"

        try:
            # Click Comment button to open editor
            comment_btn = page.locator("button").filter(has_text="Comment").first
            await comment_btn.click(timeout=DEFAULT_TIMEOUT)
            await asyncio.sleep(2)

            # Find and fill the comment editor
            editor = page.locator("[contenteditable='true'][role='textbox']").first
            await editor.click(timeout=DEFAULT_TIMEOUT)
            await asyncio.sleep(1)
            await page.keyboard.type(text, delay=15)
            await asyncio.sleep(3)

            # Submit via the last "Comment" button (which is the submit button)
            submit_btn = page.locator("button").filter(has_text="Comment").last
            await submit_btn.click(timeout=DEFAULT_TIMEOUT)
            await asyncio.sleep(5)

            return f"Comment posted on {urn}:\n{text}"

        except PlaywrightTimeoutError:
            return "Timed out trying to post comment. Post may not support comments or page failed to load."
        except Exception as e:
            return f"Failed to post comment: {e}"


@mcp.tool()
async def linkedin_close() -> str:
    """Close the browser session and free resources."""
    global _pw, _context, _page

    if _context:
        await _context.close()
        _context = None
        _page = None
    if _pw:
        await _pw.stop()
        _pw = None
    return "Browser session closed."


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="LinkedIn MCP Server")
    parser.add_argument("--login", action="store_true", help="Force fresh login")
    parser.add_argument("--logout", action="store_true", help="Delete saved session")
    args = parser.parse_args()

    if args.logout:
        if os.path.exists(USER_DATA_DIR):
            shutil.rmtree(USER_DATA_DIR)
            print("Session deleted.")
        else:
            print("No session to delete.")
        sys.exit(0)

    if args.login:
        asyncio.run(_headed_login())
        print("Login complete. You can now start the MCP server normally.")
        sys.exit(0)

    mcp.run(transport="stdio")
