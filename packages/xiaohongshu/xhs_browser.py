"""Xiaohongshu browser automation module.

Manages Playwright browser lifecycle, cookie persistence, and page interactions.
"""

import asyncio
import json
import logging
import os
from pathlib import Path
from typing import Optional

from playwright.async_api import BrowserContext, Page, async_playwright

logger = logging.getLogger("xiaohongshu-mcp")

COOKIES_DIR = Path(os.path.expanduser("~/.config/xiaohongshu-mcp"))
COOKIES_FILE = COOKIES_DIR / "cookies.json"
STATE_FILE = COOKIES_DIR / "state.json"
USER_DATA_DIR = COOKIES_DIR / "browser-profile"
XHS_BASE = "https://www.xiaohongshu.com"


class XhsBrowser:
    """Manages browser lifecycle and cookie persistence for xiaohongshu."""

    def __init__(self):
        self._playwright = None
        self._context: Optional[BrowserContext] = None

    async def _check_login_required(self, page: Page) -> bool:
        """Check if XHS is showing the login modal, meaning user must authenticate."""
        login_modal = await page.query_selector(
            ".login-container, .login-modal, .reds-modal .login-container"
        )
        if not login_modal:
            return False

        # Login modal is visible — dismiss it and check if content loaded
        await page.keyboard.press("Escape")
        await page.wait_for_timeout(500)

        # After dismiss, check if meaningful content is present
        has_content = await page.evaluate('''() => {
            // Check for feed items or search results
            const feeds = document.querySelectorAll('.note-item, .search-result-item, [class*="feed-item"]');
            return feeds.length > 0;
        }''')

        return not has_content

    async def _ensure_browser(self) -> BrowserContext:
        """Launch persistent browser context. All state persists automatically."""
        if self._context:
            return self._context

        self._playwright = await async_playwright().start()
        USER_DATA_DIR.mkdir(parents=True, exist_ok=True)

        self._context = await self._playwright.chromium.launch_persistent_context(
            user_data_dir=str(USER_DATA_DIR),
            headless=os.environ.get("XHS_HEADLESS", "true").lower() == "true",
            viewport={"width": 1280, "height": 900},
            user_agent=(
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/131.0.0.0 Safari/537.36"
            ),
            locale="zh-CN",
        )

        # Migrate legacy cookies if no existing profile data
        if not (USER_DATA_DIR / "Default" / "Cookies").exists():
            await self._migrate_legacy_cookies()

        return self._context

    async def _migrate_legacy_cookies(self):
        """One-time migration of legacy cookie files into persistent context."""
        if STATE_FILE.exists():
            try:
                state = json.loads(STATE_FILE.read_text())
                cookies = state.get("cookies", [])
                if cookies:
                    await self._context.add_cookies(cookies)
                    logger.info("Migrated %d cookies from state.json", len(cookies))
                return
            except Exception as e:
                logger.warning("Failed to migrate state.json: %s", e)

        if COOKIES_FILE.exists():
            try:
                cookies = json.loads(COOKIES_FILE.read_text())
                if isinstance(cookies, list) and cookies:
                    await self._context.add_cookies(cookies)
                    logger.info("Migrated %d cookies from cookies.json", len(cookies))
            except Exception as e:
                logger.warning("Failed to migrate cookies.json: %s", e)

    async def new_page(self) -> Page:
        """Create a new page in the persistent browser context."""
        ctx = await self._ensure_browser()
        page = await ctx.new_page()
        return page

    async def save_cookies(self):
        """Explicit save — persistent context auto-saves, but this forces a state export."""
        if not self._context:
            return
        # With persistent context, cookies are auto-saved to disk.
        # This is kept for backward compat and explicit state checkpoints.
        logger.debug("Cookies auto-persisted by browser profile")

    async def delete_cookies(self):
        """Delete saved state and clear browser context cookies."""
        if COOKIES_FILE.exists():
            COOKIES_FILE.unlink()
        if STATE_FILE.exists():
            STATE_FILE.unlink()
        if self._context:
            await self._context.clear_cookies()
        logger.info("Cookies cleared")

    async def check_login(self) -> dict:
        """Check if currently logged in by visiting xiaohongshu and checking user state."""
        page = await self.new_page()
        try:
            await page.goto(f"{XHS_BASE}/explore", wait_until="domcontentloaded", timeout=30000)
            await page.wait_for_timeout(3000)

            # Dismiss any login modal
            await page.keyboard.press("Escape")
            await page.wait_for_timeout(500)

            # Check for user avatar (most reliable indicator of authenticated state)
            logged_in = await page.evaluate('''() => {
                const avatar = document.querySelector('.side-bar-component .reds-avatar, .user .reds-avatar, .user-info .reds-avatar');
                return !!avatar;
            }''')

            username = ""
            if logged_in:
                user_el = await page.query_selector(
                    ".user-name, .nickname, [class*='nickname']"
                )
                if user_el:
                    username = (await user_el.text_content() or "").strip()

            return {"is_logged_in": logged_in, "username": username}
        finally:
            await page.close()

    async def get_qrcode(self) -> dict:
        """Navigate to login page, capture QR code image."""
        page = await self.new_page()
        try:
            await page.goto(
                f"{XHS_BASE}/explore", wait_until="domcontentloaded", timeout=30000
            )
            await page.wait_for_timeout(2000)

            # Handle captcha if present — wait for user to solve it
            captcha = await page.query_selector(
                "[class*='captcha-modal'], [id*='captcha']"
            )
            if captcha:
                logger.info("Captcha detected, waiting for user to solve...")
                try:
                    await page.wait_for_selector(
                        "[class*='captcha-modal'], [id*='captcha']",
                        state="hidden",
                        timeout=60000,
                    )
                    await page.wait_for_timeout(1000)
                except Exception:
                    return {
                        "success": False,
                        "message": "验证码超时未完成，请重试",
                    }

            # Look for QR code image on the login modal (XHS auto-shows for unauth)
            qr_el = await page.query_selector(
                "img.qrcode-img, .qrcode-img, [class*='qrcode'] img, .login-container img[src*='qrcode'], .login-container img[src^='data:image']"
            )
            if not qr_el:
                # Try triggering login modal via JS (avoids overlay interception)
                await page.evaluate('''() => {
                    const btn = document.querySelector('.login-btn, button.login-btn, .side-bar-component .login-btn');
                    if (btn) btn.click();
                }''')
                await page.wait_for_timeout(2000)
                qr_el = await page.query_selector(
                    "img.qrcode-img, .qrcode-img, [class*='qrcode'] img, .login-container img[src*='qrcode'], .login-container img[src^='data:image']"
                )

            if not qr_el:
                return {
                    "success": False,
                    "message": "无法获取二维码，可能已登录或页面结构变化",
                }

            # Screenshot the QR code
            qr_bytes = await qr_el.screenshot()
            import base64

            qr_base64 = base64.b64encode(qr_bytes).decode()

            # Start waiting for login in background
            asyncio.create_task(self._wait_for_login(page))

            return {
                "success": True,
                "qr_image_base64": qr_base64,
                "timeout": "4 minutes",
                "message": "请使用小红书App扫描二维码登录",
            }
        except Exception as e:
            await page.close()
            return {"success": False, "message": f"获取二维码失败: {e}"}

    async def _wait_for_login(self, page: Page):
        """Wait for login to complete after QR scan (detect web_session value change)."""
        try:
            # Get current web_session value (unauthenticated)
            cookies = await self._context.cookies(XHS_BASE)
            initial_ws = next((c["value"] for c in cookies if c["name"] == "web_session"), None)

            # Poll for web_session value change (indicates successful login)
            for _ in range(240):  # 4 minutes, check every second
                await page.wait_for_timeout(1000)
                cookies = await self._context.cookies(XHS_BASE)
                ws = next((c["value"] for c in cookies if c["name"] == "web_session"), None)
                if ws and ws != initial_ws:
                    await page.wait_for_timeout(2000)
                    await self.save_cookies()
                    logger.info("Login successful, session persisted")
                    return
            logger.warning("Login wait timed out after 4 minutes")
        except Exception as e:
            logger.warning("Login wait failed: %s", e)
        finally:
            await page.close()

    async def search_feeds(self, keyword: str, filters: Optional[dict] = None) -> list | dict:
        """Search xiaohongshu for posts by keyword."""
        page = await self.new_page()
        try:
            search_url = f"{XHS_BASE}/search_result?keyword={keyword}&source=web_search_result_note"
            await page.goto(search_url, wait_until="domcontentloaded", timeout=30000)
            await page.wait_for_timeout(5000)

            # Dismiss any login modal overlay
            await page.keyboard.press("Escape")
            await page.wait_for_timeout(500)

            if await self._check_login_required(page):
                return {"error": "login_required", "message": "请先登录。使用 xhs_get_qrcode 获取二维码扫码登录。"}

            # Apply filters if provided
            if filters:
                await self._apply_search_filters(page, filters)
                await page.wait_for_timeout(2000)

            # Extract feeds from __INITIAL_STATE__ (Vue store)
            feeds = await self._extract_feeds_from_state(page, "search")
            await self.save_cookies()
            return feeds
        finally:
            await page.close()

    async def _apply_search_filters(self, page: Page, filters: dict):
        """Apply search filters by clicking filter tabs."""
        # Filter selectors: sort_by, note_type are filter groups
        # The reference repo uses nth-child selectors for filter groups
        filter_map = {
            "sort_by": {"综合": 1, "最新": 2, "最多点赞": 3, "最多评论": 4, "最多收藏": 5},
            "note_type": {"不限": 1, "视频": 2, "图文": 3},
            "publish_time": {"不限": 1, "一天内": 2, "一周内": 3, "半年内": 4},
        }
        # Map filter groups to their index in the XHS filter panel
        group_indices = {"sort_by": 1, "note_type": 2, "publish_time": 3}

        for key, value in filters.items():
            if key in filter_map and value in filter_map[key]:
                group_idx = group_indices[key]
                tag_idx = filter_map[key][value]
                selector = f".filter-box .filters:nth-child({group_idx}) .filter-tag-box div.tags:nth-child({tag_idx})"
                option = await page.query_selector(selector)
                if option:
                    await option.click()
                    await page.wait_for_timeout(1000)

    async def _extract_feeds_from_state(self, page: Page, mode: str = "search") -> list:
        """Extract feed data from window.__INITIAL_STATE__ (Vue store).

        This is the same approach used by the reference Go repo — XHS stores
        all server-rendered data in a global Vue state object.
        """
        # Wait for __INITIAL_STATE__ to be available
        try:
            await page.wait_for_function(
                "() => window.__INITIAL_STATE__ !== undefined",
                timeout=10000,
            )
        except Exception:
            logger.warning("__INITIAL_STATE__ not available, falling back to empty")
            return []

        if mode == "search":
            js_code = """() => {
                if (window.__INITIAL_STATE__ &&
                    window.__INITIAL_STATE__.search &&
                    window.__INITIAL_STATE__.search.feeds) {
                    const feeds = window.__INITIAL_STATE__.search.feeds;
                    const feedsData = feeds.value || feeds._value || feeds._rawValue;
                    if (feedsData && Array.isArray(feedsData)) {
                        return JSON.stringify(feedsData);
                    }
                }
                return "";
            }"""
        else:
            # Home feed / explore
            js_code = """() => {
                if (window.__INITIAL_STATE__ &&
                    window.__INITIAL_STATE__.feed &&
                    window.__INITIAL_STATE__.feed.feeds) {
                    const feeds = window.__INITIAL_STATE__.feed.feeds;
                    const feedsData = feeds.value || feeds._value || feeds._rawValue;
                    if (feedsData && Array.isArray(feedsData)) {
                        return JSON.stringify(feedsData);
                    }
                }
                return "";
            }"""

        result = await page.evaluate(js_code)
        if not result:
            return []

        try:
            raw_feeds = json.loads(result)
        except (json.JSONDecodeError, TypeError):
            return []

        # Normalize feed data into a consistent format
        feeds = []
        for item in raw_feeds:
            feed = self._normalize_feed(item)
            if feed:
                feeds.append(feed)
        return feeds

    def _normalize_feed(self, item: dict) -> Optional[dict]:
        """Normalize raw feed data from __INITIAL_STATE__ to consistent format."""
        if not isinstance(item, dict):
            return None

        note_card = item.get("noteCard") or item.get("note_card") or item
        feed_id = item.get("id") or item.get("note_id") or ""
        xsec_token = item.get("xsecToken") or item.get("xsec_token") or ""

        title = note_card.get("displayTitle") or note_card.get("display_title") or note_card.get("title") or ""
        desc = note_card.get("desc") or ""
        note_type = note_card.get("type") or ""

        # Author info
        user = note_card.get("user") or {}
        author = user.get("nickname") or user.get("nickName") or user.get("nick_name") or ""
        user_id = user.get("userId") or user.get("user_id") or ""

        # Interaction stats
        interact = note_card.get("interactInfo") or note_card.get("interact_info") or {}
        liked_count = interact.get("likedCount") or interact.get("liked_count") or "0"

        # Cover image
        cover_info = note_card.get("cover") or {}
        cover_url = ""
        if isinstance(cover_info, dict):
            cover_url = cover_info.get("urlDefault") or cover_info.get("url_default") or ""
            if not cover_url:
                info_list = cover_info.get("infoList") or cover_info.get("info_list") or []
                if info_list and isinstance(info_list, list):
                    cover_url = info_list[-1].get("url") or ""
                elif cover_info.get("url"):
                    cover_url = cover_info["url"]

        feed = {
            "feed_id": feed_id,
            "xsec_token": xsec_token,
            "title": title,
            "desc": desc[:100] if desc else "",
            "type": "video" if note_type == "video" else "image",
            "author": author,
            "user_id": user_id,
            "likes": str(liked_count),
            "cover": cover_url,
        }

        return feed if feed_id else None

    async def list_feeds(self) -> list | dict:
        """Get home feed items."""
        page = await self.new_page()
        try:
            await page.goto(
                f"{XHS_BASE}/explore", wait_until="domcontentloaded", timeout=30000
            )
            await page.wait_for_timeout(5000)

            # Dismiss any login modal overlay
            await page.keyboard.press("Escape")
            await page.wait_for_timeout(500)

            if await self._check_login_required(page):
                return {"error": "login_required", "message": "请先登录。使用 xhs_get_qrcode 获取二维码扫码登录。"}

            feeds = await self._extract_feeds_from_state(page, "home")
            await self.save_cookies()
            return feeds
        finally:
            await page.close()

    async def get_post_detail(
        self, feed_id: str, xsec_token: str = "", load_comments: bool = False
    ) -> dict:
        """Get detailed information about a specific post."""
        page = await self.new_page()
        try:
            url = f"{XHS_BASE}/explore/{feed_id}"
            if xsec_token:
                url += f"?xsec_token={xsec_token}"
            await page.goto(url, wait_until="domcontentloaded", timeout=30000)
            await page.wait_for_timeout(3000)

            if await self._check_login_required(page):
                return {"error": "login_required", "message": "请先登录。使用 xhs_get_qrcode 获取二维码扫码登录。"}

            # Extract note detail from __INITIAL_STATE__
            detail = await self._extract_note_detail(page, feed_id)

            # Optionally load comments from the state or DOM
            if load_comments:
                comments = await self._extract_comments_from_state(page, feed_id)
                if not comments:
                    comments = await self._extract_comments(page)
                detail["comments"] = comments

            detail["feed_id"] = feed_id
            await self.save_cookies()
            return detail
        finally:
            await page.close()

    async def _extract_note_detail(self, page: Page, feed_id: str) -> dict:
        """Extract note detail from __INITIAL_STATE__.note.noteDetailMap."""
        try:
            await page.wait_for_function(
                "() => window.__INITIAL_STATE__ !== undefined",
                timeout=10000,
            )
        except Exception:
            return {"title": "", "content": ""}

        js_code = f"""() => {{
            if (window.__INITIAL_STATE__ &&
                window.__INITIAL_STATE__.note &&
                window.__INITIAL_STATE__.note.noteDetailMap) {{
                const map = window.__INITIAL_STATE__.note.noteDetailMap;
                const detail = map['{feed_id}'] || map.value?.['{feed_id}'] || map._value?.['{feed_id}'];
                if (detail) {{
                    return JSON.stringify(detail);
                }}
                // Try first key if feed_id not found
                const keys = Object.keys(map);
                for (const key of keys) {{
                    if (key !== '_value' && key !== 'value' && typeof map[key] === 'object') {{
                        return JSON.stringify(map[key]);
                    }}
                }}
            }}
            return "";
        }}"""

        result = await page.evaluate(js_code)
        if not result:
            return {"title": "", "content": ""}

        try:
            raw = json.loads(result)
        except (json.JSONDecodeError, TypeError):
            return {"title": "", "content": ""}

        # Parse the note detail structure
        note = raw.get("note") or raw
        detail = {
            "title": note.get("title") or note.get("display_title") or "",
            "content": note.get("desc") or "",
            "type": note.get("type") or "",
        }

        # Author
        user = note.get("user") or {}
        detail["author"] = user.get("nickname") or user.get("nick_name") or ""
        detail["user_id"] = user.get("user_id") or user.get("userId") or ""

        # Interaction stats
        interact = note.get("interact_info") or note.get("interactInfo") or {}
        detail["interactions"] = {
            "likes": interact.get("liked_count") or interact.get("likedCount") or "0",
            "favorites": interact.get("collected_count") or interact.get("collectedCount") or "0",
            "comments": interact.get("comment_count") or interact.get("commentCount") or "0",
            "shares": interact.get("share_count") or interact.get("shareCount") or "0",
        }

        # Images
        image_list = note.get("image_list") or note.get("imageList") or []
        detail["images"] = []
        for img in image_list:
            info_list = img.get("info_list") or img.get("infoList") or []
            if info_list:
                detail["images"].append(info_list[-1].get("url") or "")
            elif img.get("url"):
                detail["images"].append(img["url"])

        # Tags
        tag_list = note.get("tag_list") or note.get("tagList") or []
        detail["tags"] = [t.get("name") or t.get("tag_name") or "" for t in tag_list if isinstance(t, dict)]

        # Time
        detail["time"] = note.get("time") or note.get("create_time") or ""
        detail["last_update_time"] = note.get("last_update_time") or ""

        return detail

    async def _extract_comments_from_state(self, page: Page, feed_id: str) -> list:
        """Extract comments from __INITIAL_STATE__.note.noteDetailMap."""
        js_code = f"""() => {{
            if (window.__INITIAL_STATE__ &&
                window.__INITIAL_STATE__.note &&
                window.__INITIAL_STATE__.note.noteDetailMap) {{
                const map = window.__INITIAL_STATE__.note.noteDetailMap;
                const detail = map['{feed_id}'] || map.value?.['{feed_id}'] || map._value?.['{feed_id}'];
                if (detail && detail.comments) {{
                    return JSON.stringify(detail.comments);
                }}
            }}
            return "";
        }}"""

        result = await page.evaluate(js_code)
        if not result:
            return []

        try:
            raw_comments = json.loads(result)
        except (json.JSONDecodeError, TypeError):
            return []

        comments = []
        for c in raw_comments:
            if not isinstance(c, dict):
                continue
            user_info = c.get("user_info") or c.get("userInfo") or {}
            comment = {
                "comment_id": c.get("id") or c.get("comment_id") or "",
                "user": user_info.get("nickname") or "",
                "user_id": user_info.get("user_id") or "",
                "content": c.get("content") or "",
                "likes": c.get("like_count") or c.get("likeCount") or "0",
                "time": c.get("create_time") or "",
            }
            # Sub-comments
            sub_comments = c.get("sub_comments") or c.get("subComments") or []
            if sub_comments:
                comment["replies"] = [
                    {
                        "user": (sc.get("user_info") or {}).get("nickname") or "",
                        "content": sc.get("content") or "",
                    }
                    for sc in sub_comments
                    if isinstance(sc, dict)
                ]
            comments.append(comment)
        return comments

    async def _extract_comments(self, page: Page) -> list:
        """Extract comments from the post detail page."""
        comments = []
        comment_els = await page.query_selector_all(
            ".comment-item, [class*='comment-item'], .parent-comment"
        )
        for el in comment_els[:30]:  # Limit to 30 comments
            try:
                comment = {}
                user_el = await el.query_selector(
                    ".user-name, .nickname, [class*='name']"
                )
                if user_el:
                    comment["user"] = (await user_el.text_content() or "").strip()

                content_el = await el.query_selector(
                    ".content, .comment-content, [class*='content']"
                )
                if content_el:
                    comment["content"] = (
                        await content_el.text_content() or ""
                    ).strip()

                # Comment ID from data attribute
                comment_id = await el.get_attribute("data-id") or await el.get_attribute("id")
                if comment_id:
                    comment["comment_id"] = comment_id

                if comment.get("content"):
                    comments.append(comment)
            except Exception:
                continue

        return comments

    async def like_feed(self, feed_id: str, xsec_token: str = "", unlike: bool = False) -> dict:
        """Like or unlike a post."""
        page = await self.new_page()
        try:
            url = f"{XHS_BASE}/explore/{feed_id}"
            if xsec_token:
                url += f"?xsec_token={xsec_token}"
            await page.goto(url, wait_until="domcontentloaded", timeout=30000)
            await page.wait_for_timeout(3000)

            # Find like button
            like_btn = await page.query_selector(
                ".like-wrapper .like-icon, [class*='like-wrapper'] .like-active, "
                ".like-wrapper, [class*='like-container'], .engage-bar .like"
            )
            if not like_btn:
                return {"success": False, "message": "找不到点赞按钮"}

            # Check current like state
            is_liked = await page.query_selector(
                ".like-wrapper.active, [class*='like-active'], .liked"
            )

            if unlike and is_liked:
                await like_btn.click()
                await page.wait_for_timeout(1000)
                await self.save_cookies()
                return {"success": True, "feed_id": feed_id, "message": "取消点赞成功"}
            elif not unlike and not is_liked:
                await like_btn.click()
                await page.wait_for_timeout(1000)
                await self.save_cookies()
                return {"success": True, "feed_id": feed_id, "message": "点赞成功"}
            else:
                action = "取消点赞" if unlike else "点赞"
                return {
                    "success": True,
                    "feed_id": feed_id,
                    "message": f"已{action}，无需重复操作",
                }
        finally:
            await page.close()

    async def favorite_feed(
        self, feed_id: str, xsec_token: str = "", unfavorite: bool = False
    ) -> dict:
        """Favorite or unfavorite a post."""
        page = await self.new_page()
        try:
            url = f"{XHS_BASE}/explore/{feed_id}"
            if xsec_token:
                url += f"?xsec_token={xsec_token}"
            await page.goto(url, wait_until="domcontentloaded", timeout=30000)
            await page.wait_for_timeout(3000)

            # Find favorite/collect button
            fav_btn = await page.query_selector(
                ".collect-wrapper, [class*='collect-wrapper'], "
                ".engage-bar .collect, [class*='collect-container']"
            )
            if not fav_btn:
                return {"success": False, "message": "找不到收藏按钮"}

            # Check current state
            is_faved = await page.query_selector(
                ".collect-wrapper.active, [class*='collect-active'], .collected"
            )

            if unfavorite and is_faved:
                await fav_btn.click()
                await page.wait_for_timeout(1000)
                await self.save_cookies()
                return {"success": True, "feed_id": feed_id, "message": "取消收藏成功"}
            elif not unfavorite and not is_faved:
                await fav_btn.click()
                await page.wait_for_timeout(1000)
                await self.save_cookies()
                return {"success": True, "feed_id": feed_id, "message": "收藏成功"}
            else:
                action = "取消收藏" if unfavorite else "收藏"
                return {
                    "success": True,
                    "feed_id": feed_id,
                    "message": f"已{action}，无需重复操作",
                }
        finally:
            await page.close()

    async def post_comment(
        self, feed_id: str, xsec_token: str, content: str
    ) -> dict:
        """Post a comment on a feed."""
        page = await self.new_page()
        try:
            url = f"{XHS_BASE}/explore/{feed_id}"
            if xsec_token:
                url += f"?xsec_token={xsec_token}"
            await page.goto(url, wait_until="domcontentloaded", timeout=30000)
            await page.wait_for_timeout(3000)

            # Find comment input
            comment_input = await page.query_selector(
                "#content-textarea, .comment-input textarea, "
                "[class*='comment-input'], [placeholder*='评论']"
            )
            if not comment_input:
                # Try clicking "say something" area to activate input
                comment_area = await page.query_selector(
                    ".comment-inner, [class*='comment-inner'], "
                    "[class*='input-box'], .reply-container"
                )
                if comment_area:
                    await comment_area.click()
                    await page.wait_for_timeout(1000)
                    comment_input = await page.query_selector(
                        "#content-textarea, textarea, [contenteditable='true']"
                    )

            if not comment_input:
                return {"success": False, "message": "找不到评论输入框"}

            await comment_input.fill(content)
            await page.wait_for_timeout(500)

            # Click submit button
            submit_btn = await page.query_selector(
                ".submit-btn, [class*='submit'], button:has-text('发送'), "
                "button:has-text('评论')"
            )
            if submit_btn:
                await submit_btn.click()
                await page.wait_for_timeout(2000)
                await self.save_cookies()
                return {
                    "success": True,
                    "feed_id": feed_id,
                    "message": "评论发表成功",
                }
            else:
                # Try pressing Enter
                await comment_input.press("Enter")
                await page.wait_for_timeout(2000)
                await self.save_cookies()
                return {
                    "success": True,
                    "feed_id": feed_id,
                    "message": "评论发表成功(Enter提交)",
                }
        finally:
            await page.close()

    async def publish_content(
        self,
        title: str,
        content: str,
        images: list[str],
        tags: Optional[list[str]] = None,
        visibility: str = "公开可见",
    ) -> dict:
        """Publish image content to xiaohongshu."""
        if not images:
            return {"success": False, "message": "至少需要1张图片"}

        page = await self.new_page()
        try:
            # Navigate to publish page
            await page.goto(
                f"{XHS_BASE}/publish/publish", wait_until="domcontentloaded", timeout=30000
            )
            await page.wait_for_timeout(3000)

            # Upload images
            file_input = await page.query_selector(
                "input[type='file'], [class*='upload'] input"
            )
            if not file_input:
                return {"success": False, "message": "找不到图片上传入口"}

            # Filter to local file paths only
            local_images = [img for img in images if not img.startswith("http")]
            if not local_images:
                return {
                    "success": False,
                    "message": "请提供本地图片路径",
                }

            await file_input.set_input_files(local_images)
            await page.wait_for_timeout(3000)  # Wait for upload

            # Fill title
            title_input = await page.query_selector(
                "[placeholder*='标题'], #post-title, [class*='title'] input, "
                "[class*='title'] textarea"
            )
            if title_input:
                await title_input.fill(title)

            # Fill content
            content_input = await page.query_selector(
                "[placeholder*='正文'], #post-content, "
                "[class*='content'] textarea, [class*='ql-editor']"
            )
            if content_input:
                await content_input.fill(content)

            # Add tags
            if tags:
                for tag in tags:
                    tag_input = await page.query_selector(
                        "[placeholder*='话题'], [class*='tag'] input"
                    )
                    if tag_input:
                        await tag_input.fill(f"#{tag}")
                        await page.wait_for_timeout(500)
                        await tag_input.press("Enter")
                        await page.wait_for_timeout(500)

            # Click publish button
            publish_btn = await page.query_selector(
                "button:has-text('发布'), [class*='publish-btn'], "
                ".submit-btn, button.btn-publish"
            )
            if publish_btn:
                await publish_btn.click()
                await page.wait_for_timeout(5000)
                await self.save_cookies()
                return {
                    "success": True,
                    "title": title,
                    "images": len(local_images),
                    "message": "发布成功",
                }
            else:
                return {"success": False, "message": "找不到发布按钮"}
        finally:
            await page.close()

    async def close(self):
        """Cleanup browser resources."""
        if self._context:
            await self._context.close()
            self._context = None
        if self._playwright:
            await self._playwright.stop()
            self._playwright = None
