#!/usr/bin/env python3
"""LinkedIn MCP Server — read inbox, conversations, send messages, search people, view profiles.

Uses Patchright (stealth Playwright fork) for browser automation.
First run opens a headed browser for manual login. Session is saved and reused.

Usage:
  .venv/bin/python mcp_server.py
  .venv/bin/python mcp_server.py --login    # Force fresh login
  .venv/bin/python mcp_server.py --logout   # Delete saved session
"""

import argparse
import asyncio
import json
import logging
import os
import re
import shutil
import stat
import sys
from datetime import datetime
from typing import Optional

from mcp.server.fastmcp import FastMCP
from patchright.async_api import async_playwright, Browser, BrowserContext, Page

logger = logging.getLogger("linkedin-mcp")

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

SESSION_DIR = os.path.expanduser("~/.linkedin-mcp")
USER_DATA_DIR = os.path.join(SESSION_DIR, "browser-data")
LINKEDIN_BASE = "https://www.linkedin.com"
DEFAULT_TIMEOUT = 30_000  # ms
NAV_TIMEOUT = 45_000  # ms for page navigation

# ---------------------------------------------------------------------------
# MCP Server
# ---------------------------------------------------------------------------

mcp = FastMCP(
    "linkedin",
    instructions=(
        "Read and send LinkedIn messages, search people, view profiles. "
        "Tools: linkedin_inbox, linkedin_conversation, linkedin_send_message, "
        "linkedin_search_people, linkedin_profile, linkedin_login, linkedin_close."
    ),
)

# ---------------------------------------------------------------------------
# Browser lifecycle
# ---------------------------------------------------------------------------

_browser: Optional[Browser] = None
_context: Optional[BrowserContext] = None
_page: Optional[Page] = None


def _secure_mkdir(path: str) -> None:
    """Create directory with restrictive permissions (owner-only)."""
    os.makedirs(path, exist_ok=True)
    os.chmod(path, stat.S_IRWXU)


async def _get_page() -> Page:
    """Get or create a persistent browser page with saved session."""
    global _browser, _context, _page

    if _page and not _page.is_closed():
        return _page

    _secure_mkdir(SESSION_DIR)
    _secure_mkdir(USER_DATA_DIR)

    pw = await async_playwright().start()
    _context = await pw.chromium.launch_persistent_context(
        user_data_dir=USER_DATA_DIR,
        headless=False,
        viewport={"width": 1280, "height": 900},
        user_agent=(
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/125.0.0.0 Safari/537.36"
        ),
        args=[
            "--headless=new",
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


async def _ensure_logged_in(page: Page) -> bool:
    """Check if we're logged into LinkedIn. Returns True if logged in."""
    try:
        await page.goto(f"{LINKEDIN_BASE}/feed/", wait_until="domcontentloaded")
        await page.wait_for_timeout(2000)

        # If redirected to login page, we're not authenticated
        if "/login" in page.url or "/authwall" in page.url or "/checkpoint" in page.url:
            return False

        # Check for any sign of being logged in (nav, feed, or profile elements)
        logged_in_el = await page.query_selector(
            "nav, header, div.feed-shared-update-v2"
        )
        return logged_in_el is not None
    except Exception:
        return False


async def _headed_login() -> str:
    """Open a headed browser for manual login. Blocks until user completes login."""
    global _browser, _context, _page

    # Close existing headless context
    if _context:
        await _context.close()
        _context = None
        _page = None

    pw = await async_playwright().start()
    _context = await pw.chromium.launch_persistent_context(
        user_data_dir=USER_DATA_DIR,
        headless=False,  # User sees the browser
        viewport={"width": 1280, "height": 900},
        user_agent=(
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/125.0.0.0 Safari/537.36"
        ),
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

    _page.set_default_timeout(120_000)  # 2 min for manual login
    _page.set_default_navigation_timeout(120_000)

    await _page.goto(f"{LINKEDIN_BASE}/login", wait_until="domcontentloaded")

    # Wait for user to complete login — detected by navigation to /feed/
    try:
        await _page.wait_for_url("**/feed/**", timeout=120_000)
    except Exception:
        # Check if they landed somewhere else post-login
        if "/login" in _page.url or "/authwall" in _page.url:
            return "Login timed out. Please try again with linkedin_login."

    # Close headed browser and reopen headless with same session
    await _context.close()
    _context = None
    _page = None

    return "Login successful. Session saved."


async def _navigate_and_wait(page: Page, url: str) -> None:
    """Navigate to URL and wait for content to stabilize."""
    await page.goto(url, wait_until="domcontentloaded")
    await page.wait_for_timeout(2000)


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
    page = await _get_page()

    if not await _ensure_logged_in(page):
        return "Not logged in. Call linkedin_login first."

    await _navigate_and_wait(page, f"{LINKEDIN_BASE}/messaging/")

    # Wait for conversation list to load
    try:
        await page.wait_for_selector(
            "li.msg-conversation-listitem", timeout=15_000
        )
    except Exception:
        return "Could not load messaging inbox. LinkedIn may have changed their UI."

    conversations = await page.query_selector_all("li.msg-conversation-listitem")
    results = []

    for i, conv in enumerate(conversations[:limit]):
        try:
            # Extract participant name
            name_el = await conv.query_selector(
                "h3.msg-conversation-listitem__participant-names, "
                "span.msg-conversation-listitem__participant-names"
            )
            name = (await name_el.inner_text()).strip() if name_el else "Unknown"

            # Extract last message snippet
            snippet_el = await conv.query_selector(
                "p.msg-conversation-listitem__message-snippet, "
                "span.msg-conversation-card__message-snippet-body"
            )
            snippet = (await snippet_el.inner_text()).strip() if snippet_el else ""

            # Extract timestamp
            time_el = await conv.query_selector(
                "time.msg-conversation-listitem__time-stamp, "
                "time.msg-conversation-card__time-stamp"
            )
            timestamp = (await time_el.inner_text()).strip() if time_el else ""

            # Extract conversation link for later use
            link_el = await conv.query_selector("a[href*='/messaging/thread/']")
            thread_id = ""
            if link_el:
                href = await link_el.get_attribute("href") or ""
                match = re.search(r"/messaging/thread/([^/]+)", href)
                if match:
                    thread_id = match.group(1)

            entry = f"{i+1}. {name}"
            if timestamp:
                entry += f" ({timestamp})"
            if thread_id:
                entry += f" [thread:{thread_id}]"
            if snippet:
                entry += f"\n   {snippet[:100]}"

            results.append(entry)
        except Exception:
            continue

    if not results:
        return "No conversations found in inbox."

    return f"LinkedIn Inbox ({len(results)} conversations):\n\n" + "\n\n".join(results)


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
    page = await _get_page()

    if not await _ensure_logged_in(page):
        return "Not logged in. Call linkedin_login first."

    if thread_id:
        await _navigate_and_wait(
            page, f"{LINKEDIN_BASE}/messaging/thread/{thread_id}/"
        )
    else:
        # Navigate to messaging and search for the person
        await _navigate_and_wait(page, f"{LINKEDIN_BASE}/messaging/")
        try:
            search_input = await page.wait_for_selector(
                "input.msg-search-form__search-field, "
                "input[placeholder*='Search messages']",
                timeout=10_000,
            )
            if search_input:
                await search_input.fill(name)
                await page.keyboard.press("Enter")
                await page.wait_for_timeout(3000)

                # Click first matching conversation
                first_result = await page.query_selector(
                    "li.msg-conversation-listitem"
                )
                if first_result:
                    await first_result.click()
                    await page.wait_for_timeout(2000)
                else:
                    return f"No conversation found matching '{name}'."
        except Exception:
            return f"Could not search for conversation with '{name}'."

    # Wait for messages to load
    try:
        await page.wait_for_selector(
            "li.msg-s-message-list__event, div.msg-s-event-listitem",
            timeout=10_000,
        )
    except Exception:
        return "Could not load conversation messages."

    # Extract messages
    messages = await page.query_selector_all(
        "li.msg-s-message-list__event, div.msg-s-event-listitem"
    )

    results = []
    for msg in messages[-limit:]:
        try:
            # Sender name
            sender_el = await msg.query_selector(
                "span.msg-s-message-group__name, "
                "span.msg-s-event-listitem__name"
            )
            sender = (await sender_el.inner_text()).strip() if sender_el else "Unknown"

            # Timestamp
            time_el = await msg.query_selector(
                "time.msg-s-message-group__timestamp, "
                "time.msg-s-event-listitem__timestamp"
            )
            timestamp = (await time_el.inner_text()).strip() if time_el else ""

            # Message body
            body_el = await msg.query_selector(
                "p.msg-s-event-listitem__body, "
                "div.msg-s-event-listitem__body, "
                "p.msg-s-message-body"
            )
            body = (await body_el.inner_text()).strip() if body_el else "[no text]"

            entry = f"[{timestamp}] {sender}: {body}"
            results.append(entry)
        except Exception:
            continue

    if not results:
        return "No messages found in this conversation."

    # Get conversation participant name from header
    header_el = await page.query_selector(
        "h2.msg-overlay-bubble-header__title, "
        "h2.msg-thread__title"
    )
    header = (await header_el.inner_text()).strip() if header_el else "Conversation"

    return f"{header} ({len(results)} messages):\n\n" + "\n".join(results)


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

    page = await _get_page()

    if not await _ensure_logged_in(page):
        return "Not logged in. Call linkedin_login first."

    if thread_id:
        await _navigate_and_wait(
            page, f"{LINKEDIN_BASE}/messaging/thread/{thread_id}/"
        )
    else:
        # Navigate to conversation by name search
        await _navigate_and_wait(page, f"{LINKEDIN_BASE}/messaging/")
        try:
            search_input = await page.wait_for_selector(
                "input.msg-search-form__search-field, "
                "input[placeholder*='Search messages']",
                timeout=10_000,
            )
            if search_input:
                await search_input.fill(name)
                await page.keyboard.press("Enter")
                await page.wait_for_timeout(3000)

                first_result = await page.query_selector(
                    "li.msg-conversation-listitem"
                )
                if first_result:
                    await first_result.click()
                    await page.wait_for_timeout(2000)
                else:
                    return f"No conversation found matching '{name}'."
        except Exception:
            return f"Could not navigate to conversation with '{name}'."

    # Find message input and type
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
        await page.wait_for_timeout(500)

        # Click send button
        send_btn = await page.query_selector(
            "button.msg-form__send-button, "
            "button[type='submit'].msg-form__send-btn"
        )
        if not send_btn:
            # Try keyboard shortcut
            await page.keyboard.press("Enter")
        else:
            await send_btn.click()

        await page.wait_for_timeout(2000)

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
    page = await _get_page()

    if not await _ensure_logged_in(page):
        return "Not logged in. Call linkedin_login first."

    search_url = (
        f"{LINKEDIN_BASE}/search/results/people/"
        f"?keywords={query.replace(' ', '%20')}"
    )
    await _navigate_and_wait(page, search_url)

    try:
        await page.wait_for_selector(
            "li.reusable-search__result-container, "
            "div.entity-result",
            timeout=15_000,
        )
    except Exception:
        return f"No results found for '{query}' or page failed to load."

    results_els = await page.query_selector_all(
        "li.reusable-search__result-container, div.entity-result"
    )

    results = []
    for el in results_els[:limit]:
        try:
            # Name and link
            name_el = await el.query_selector(
                "span.entity-result__title-text a span[aria-hidden='true'], "
                "a.app-aware-link span[dir='ltr']"
            )
            person_name = (await name_el.inner_text()).strip() if name_el else "Unknown"

            # Profile URL
            link_el = await el.query_selector(
                "a.app-aware-link[href*='/in/']"
            )
            profile_url = ""
            if link_el:
                href = await link_el.get_attribute("href") or ""
                match = re.search(r"(/in/[^?]+)", href)
                if match:
                    profile_url = match.group(1)

            # Headline / subtitle
            subtitle_el = await el.query_selector(
                "div.entity-result__primary-subtitle, "
                "div.linked-area div.t-14"
            )
            subtitle = (await subtitle_el.inner_text()).strip() if subtitle_el else ""

            # Location
            loc_el = await el.query_selector(
                "div.entity-result__secondary-subtitle"
            )
            location = (await loc_el.inner_text()).strip() if loc_el else ""

            entry = f"• {person_name}"
            if profile_url:
                entry += f" ({profile_url})"
            if subtitle:
                entry += f"\n  {subtitle}"
            if location:
                entry += f" — {location}"

            results.append(entry)
        except Exception:
            continue

    if not results:
        return f"No people found for '{query}'."

    return f"People matching '{query}' ({len(results)} results):\n\n" + "\n\n".join(results)


@mcp.tool()
async def linkedin_profile(username: str) -> str:
    """View a LinkedIn profile by username.

    Args:
        username: LinkedIn username (the part after /in/ in the URL)
    """
    if not username.strip():
        return "Username required (e.g., 'johndoe' from linkedin.com/in/johndoe)."

    # Strip URL prefix if user passed full URL
    username = re.sub(r".*linkedin\.com/in/", "", username).strip("/")

    page = await _get_page()

    if not await _ensure_logged_in(page):
        return "Not logged in. Call linkedin_login first."

    await _navigate_and_wait(page, f"{LINKEDIN_BASE}/in/{username}/")

    # Check for 404 / profile not found
    if "404" in (await page.title()) or "/404" in page.url:
        return f"Profile not found: {username}"

    sections = {}

    # Name and headline
    try:
        name_el = await page.query_selector("h1.text-heading-xlarge, h1.inline")
        sections["name"] = (await name_el.inner_text()).strip() if name_el else username

        headline_el = await page.query_selector(
            "div.text-body-medium.break-words"
        )
        if headline_el:
            sections["headline"] = (await headline_el.inner_text()).strip()

        location_el = await page.query_selector(
            "span.text-body-small.inline.t-black--light.break-words"
        )
        if location_el:
            sections["location"] = (await location_el.inner_text()).strip()
    except Exception:
        pass

    # About section
    try:
        about_section = await page.query_selector(
            "section.pv-about-section, div#about ~ div"
        )
        if about_section:
            about_text = await about_section.inner_text()
            sections["about"] = about_text.strip()[:500]
    except Exception:
        pass

    # Experience (first 5)
    try:
        exp_items = await page.query_selector_all(
            "li.artdeco-list__item[class*='pvs-list__paged-list-item']"
        )
        experiences = []
        for item in exp_items[:5]:
            text = (await item.inner_text()).strip()
            if text:
                # Clean up multi-line noise
                lines = [l.strip() for l in text.split("\n") if l.strip()]
                experiences.append(" | ".join(lines[:4]))

        if experiences:
            sections["experience"] = "\n".join(f"  - {e}" for e in experiences)
    except Exception:
        pass

    # Format output
    output_lines = [f"LinkedIn Profile: {sections.get('name', username)}"]
    output_lines.append(f"URL: {LINKEDIN_BASE}/in/{username}/")

    if "headline" in sections:
        output_lines.append(f"Headline: {sections['headline']}")
    if "location" in sections:
        output_lines.append(f"Location: {sections['location']}")
    if "about" in sections:
        output_lines.append(f"\nAbout:\n{sections['about']}")
    if "experience" in sections:
        output_lines.append(f"\nExperience:\n{sections['experience']}")

    return "\n".join(output_lines)


@mcp.tool()
async def linkedin_close() -> str:
    """Close the browser session and free resources."""
    global _context, _page

    if _context:
        await _context.close()
        _context = None
        _page = None
        return "Browser session closed."

    return "No active session."


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
