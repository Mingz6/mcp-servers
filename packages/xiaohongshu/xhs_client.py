"""XHS API client wrapper using xiaohongshu-cli library.

Replaces the Playwright browser backend with direct API calls via the
xhs_cli package (reverse-engineered XHS API). ~20MB memory, 1-4s responses,
7-day sessions vs Playwright's 300MB, 10s, 12h.

Cookies stored at: ~/.xiaohongshu-cli/cookies.json
"""

from __future__ import annotations

import asyncio
import json
import logging
import sys
from functools import partial
from pathlib import Path
from typing import Any

# xhs_cli is installed as a uv tool — add to path if needed
_XHS_CLI_SITE = Path.home() / ".local/share/uv/tools/xiaohongshu-cli/lib/python3.12/site-packages"
if _XHS_CLI_SITE.exists() and str(_XHS_CLI_SITE) not in sys.path:
    sys.path.insert(0, str(_XHS_CLI_SITE))

from xhs_cli.client import XhsClient
from xhs_cli.cookies import load_saved_cookies, save_cookies, clear_cookies
from xhs_cli.exceptions import SessionExpiredError, NeedVerifyError, XhsApiError

logger = logging.getLogger("xiaohongshu-mcp")

# Map Chinese filter labels → xhs_cli API values
_SORT_MAP = {"综合": "general", "最新": "latest", "最多点赞": "popular"}
_NOTE_TYPE_MAP = {"不限": 0, "视频": 1, "图文": 2}


class XhsApiClient:
    """Async-friendly wrapper around xhs_cli.XhsClient (synchronous)."""

    def __init__(self):
        self._client: XhsClient | None = None

    def _ensure_client(self) -> XhsClient:
        """Load cookies and create client. Raises if no cookies."""
        if self._client is not None:
            return self._client
        cookies = load_saved_cookies()
        if not cookies:
            raise SessionExpiredError("未登录。请先使用 xhs_get_qrcode 扫码登录。")
        self._client = XhsClient(cookies, request_delay=0.5)
        return self._client

    def _reset_client(self):
        """Force re-creation of client on next call (e.g. after login)."""
        self._client = None

    async def _run(self, fn, *args, **kwargs) -> Any:
        """Run a synchronous client method in a thread."""
        return await asyncio.to_thread(fn, *args, **kwargs)

    # --- Auth ---

    async def check_login(self) -> dict:
        """Check login status by calling self-info endpoint."""
        try:
            client = self._ensure_client()
            info = await self._run(client.get_self_info)
            nickname = info.get("nickname") or info.get("nick_name") or ""
            return {"is_logged_in": True, "username": nickname, "user_id": info.get("user_id", "")}
        except SessionExpiredError:
            return {"is_logged_in": False, "username": "", "message": "未登录或Session已过期"}
        except (XhsApiError, Exception) as e:
            return {"is_logged_in": False, "username": "", "message": str(e)}

    async def get_qrcode(self) -> dict:
        """Generate QR code for login. Returns QR URL for user to scan."""
        try:
            # Create a temporary client with minimal cookies for QR generation
            cookies = load_saved_cookies() or {"a1": ""}
            client = XhsClient(cookies, request_delay=0.5)
            result = await self._run(client.create_qr_login)
            qr_url = result.get("url") or result.get("qr_url") or ""
            qr_id = result.get("qr_id") or result.get("id") or ""
            code = result.get("code") or ""
            return {
                "success": True,
                "qr_url": qr_url,
                "qr_id": qr_id,
                "code": code,
                "message": "请在浏览器中打开QR URL扫码，或使用小红书App扫码。扫码后调用 xhs_check_qr_status 检查状态。",
            }
        except Exception as e:
            return {"success": False, "message": f"获取二维码失败: {e}"}

    async def check_qr_status(self, qr_id: str, code: str) -> dict:
        """Poll QR login status."""
        try:
            cookies = load_saved_cookies() or {"a1": ""}
            client = XhsClient(cookies, request_delay=0.5)
            result = await self._run(client.check_qr_status, qr_id, code)
            return result
        except Exception as e:
            return {"success": False, "message": str(e)}

    async def delete_cookies(self):
        """Clear saved cookies."""
        clear_cookies()
        self._reset_client()

    # --- Search ---

    async def search(
        self,
        keyword: str,
        sort_by: str = "综合",
        note_type: str = "不限",
        page: int = 1,
    ) -> list | dict:
        """Search notes. Returns normalized feed list."""
        try:
            client = self._ensure_client()
            sort = _SORT_MAP.get(sort_by, "general")
            nt = _NOTE_TYPE_MAP.get(note_type, 0)
            result = await self._run(client.search_notes, keyword, page=page, sort=sort, note_type=nt)

            items = result.get("items", []) if isinstance(result, dict) else []
            feeds = []
            for item in items:
                feed = self._normalize_search_item(item)
                if feed:
                    feeds.append(feed)
            return feeds
        except SessionExpiredError:
            self._reset_client()
            return {"error": "login_required", "message": "Session已过期，需要重新登录。"}
        except NeedVerifyError:
            return {"error": "captcha_required", "message": "需要人机验证，请稍后重试。"}
        except XhsApiError as e:
            return {"error": "api_error", "message": str(e)}

    # --- Feed ---

    async def list_feed(self) -> list | dict:
        """Get home feed."""
        try:
            client = self._ensure_client()
            result = await self._run(client.get_home_feed)
            items = result.get("items", []) if isinstance(result, dict) else []
            feeds = []
            for item in items:
                feed = self._normalize_feed_item(item)
                if feed:
                    feeds.append(feed)
            return feeds
        except SessionExpiredError:
            self._reset_client()
            return {"error": "login_required", "message": "Session已过期，需要重新登录。"}
        except XhsApiError as e:
            return {"error": "api_error", "message": str(e)}

    # --- Post Detail ---

    async def get_post_detail(self, note_id: str, xsec_token: str = "", load_comments: bool = False) -> dict:
        """Get note detail."""
        try:
            client = self._ensure_client()
            result = await self._run(client.get_note_detail, note_id, xsec_token=xsec_token)

            detail = self._normalize_note_detail(result)
            detail["feed_id"] = note_id

            if load_comments:
                comments = await self.get_comments(note_id, xsec_token=xsec_token)
                detail["comments"] = comments

            return detail
        except SessionExpiredError:
            self._reset_client()
            return {"error": "login_required", "message": "Session已过期，需要重新登录。"}
        except XhsApiError as e:
            return {"error": "api_error", "message": str(e)}

    async def get_comments(self, note_id: str, xsec_token: str = "") -> list:
        """Get comments for a note."""
        try:
            client = self._ensure_client()
            result = await self._run(client.get_comments, note_id, xsec_token=xsec_token)
            raw_comments = result.get("comments", []) if isinstance(result, dict) else []
            comments = []
            for c in raw_comments:
                if not isinstance(c, dict):
                    continue
                user_info = c.get("user_info") or {}
                comment = {
                    "comment_id": c.get("id") or "",
                    "user": user_info.get("nickname") or "",
                    "user_id": user_info.get("user_id") or "",
                    "content": c.get("content") or "",
                    "likes": c.get("like_count") or "0",
                    "time": c.get("create_time") or "",
                }
                sub_comments = c.get("sub_comments") or []
                if sub_comments:
                    comment["replies"] = [
                        {"user": (sc.get("user_info") or {}).get("nickname", ""), "content": sc.get("content", "")}
                        for sc in sub_comments if isinstance(sc, dict)
                    ]
                comments.append(comment)
            return comments
        except (XhsApiError, Exception) as e:
            logger.warning("Failed to load comments: %s", e)
            return []

    # --- Interactions ---

    async def like(self, note_id: str, unlike: bool = False) -> dict:
        """Like or unlike a note."""
        try:
            client = self._ensure_client()
            if unlike:
                await self._run(client.unlike_note, note_id)
                return {"success": True, "feed_id": note_id, "message": "取消点赞成功"}
            else:
                await self._run(client.like_note, note_id)
                return {"success": True, "feed_id": note_id, "message": "点赞成功"}
        except SessionExpiredError:
            self._reset_client()
            return {"success": False, "message": "Session已过期，需要重新登录。"}
        except XhsApiError as e:
            return {"success": False, "message": str(e)}

    async def favorite(self, note_id: str, unfavorite: bool = False) -> dict:
        """Favorite or unfavorite a note."""
        try:
            client = self._ensure_client()
            if unfavorite:
                await self._run(client.unfavorite_note, note_id)
                return {"success": True, "feed_id": note_id, "message": "取消收藏成功"}
            else:
                await self._run(client.favorite_note, note_id)
                return {"success": True, "feed_id": note_id, "message": "收藏成功"}
        except SessionExpiredError:
            self._reset_client()
            return {"success": False, "message": "Session已过期，需要重新登录。"}
        except XhsApiError as e:
            return {"success": False, "message": str(e)}

    async def post_comment(self, note_id: str, content: str) -> dict:
        """Post a comment on a note."""
        try:
            client = self._ensure_client()
            await self._run(client.post_comment, note_id, content)
            return {"success": True, "feed_id": note_id, "message": "评论发表成功"}
        except SessionExpiredError:
            self._reset_client()
            return {"success": False, "message": "Session已过期，需要重新登录。"}
        except XhsApiError as e:
            return {"success": False, "message": str(e)}

    # --- Publish ---

    async def publish(
        self,
        title: str,
        content: str,
        images: list[str],
        tags: list[str] | None = None,
        is_private: bool = False,
    ) -> dict:
        """Publish an image note."""
        if not images:
            return {"success": False, "message": "至少需要1张图片"}

        try:
            client = self._ensure_client()

            # Upload images
            file_ids = []
            for img_path in images:
                permit = await self._run(client.get_upload_permit, "image", 1)
                await self._run(client.upload_file, permit["fileId"], permit["token"], img_path)
                file_ids.append(permit["fileId"])

            # Resolve topic tags
            topics = []
            if tags:
                for tag in tags:
                    try:
                        result = await self._run(client.search_topics, tag)
                        topic_list = result.get("topics", [])
                        if topic_list:
                            topics.append({
                                "id": topic_list[0].get("id", ""),
                                "name": topic_list[0].get("name", tag),
                                "type": "topic",
                            })
                    except Exception:
                        pass

            result = await self._run(
                client.create_image_note, title, content, file_ids, topics or None, is_private
            )
            return {"success": True, "title": title, "images": len(file_ids), "message": "发布成功", "data": result}
        except SessionExpiredError:
            self._reset_client()
            return {"success": False, "message": "Session已过期，需要重新登录。"}
        except XhsApiError as e:
            return {"success": False, "message": str(e)}

    # --- Social ---

    async def search_users(self, keyword: str) -> list | dict:
        """Search for users by keyword."""
        try:
            client = self._ensure_client()
            result = await self._run(client.search_users, keyword)
            raw_users = result.get("user_info_dtos", []) if isinstance(result, dict) else []
            return [
                {
                    "user_id": u.get("user_base_dto", {}).get("user_id") or "",
                    "nickname": u.get("user_base_dto", {}).get("user_nickname") or "",
                    "desc": u.get("user_base_dto", {}).get("desc") or "",
                    "fans": u.get("fans_total") or 0,
                    "avatar": u.get("user_base_dto", {}).get("image") or "",
                }
                for u in raw_users if isinstance(u, dict)
            ]
        except SessionExpiredError:
            self._reset_client()
            return {"error": "login_required", "message": "Session已过期，需要重新登录。"}
        except XhsApiError as e:
            return {"error": "api_error", "message": str(e)}

    async def get_user_info(self, user_id: str) -> dict:
        """Get user profile info."""
        try:
            client = self._ensure_client()
            result = await self._run(client.get_user_info, user_id)
            return {
                "user_id": result.get("user_id") or user_id,
                "nickname": result.get("nickname") or "",
                "desc": result.get("desc") or "",
                "gender": result.get("gender") or "",
                "fans": result.get("fans") or "",
                "follows": result.get("follows") or "",
                "notes": result.get("notes") or "",
                "liked_and_collected": result.get("interaction") or "",
                "avatar": result.get("image") or result.get("imageb") or "",
                "ip_location": result.get("ip_location") or "",
                "tags": [t.get("name", "") for t in (result.get("tags") or []) if isinstance(t, dict)],
            }
        except SessionExpiredError:
            self._reset_client()
            return {"error": "login_required", "message": "Session已过期，需要重新登录。"}
        except XhsApiError as e:
            return {"error": "api_error", "message": str(e)}

    async def get_user_notes(self, user_id: str, cursor: str = "") -> dict:
        """Get a user's published notes."""
        try:
            client = self._ensure_client()
            result = await self._run(client.get_user_notes, user_id, cursor)
            notes = result.get("notes", []) if isinstance(result, dict) else []
            return {
                "user_id": user_id,
                "cursor": result.get("cursor", ""),
                "has_more": result.get("has_more", False),
                "notes": [
                    {
                        "note_id": n.get("note_id") or n.get("id") or "",
                        "title": n.get("display_title") or n.get("title") or "",
                        "type": n.get("type") or "",
                        "likes": n.get("liked_count") or n.get("interact_info", {}).get("liked_count", "0"),
                        "cover": self._extract_cover_url(n.get("cover") or {}),
                    }
                    for n in notes if isinstance(n, dict)
                ],
            }
        except SessionExpiredError:
            self._reset_client()
            return {"error": "login_required", "message": "Session已过期，需要重新登录。"}
        except XhsApiError as e:
            return {"error": "api_error", "message": str(e)}

    async def follow_user(self, user_id: str, unfollow: bool = False) -> dict:
        """Follow or unfollow a user."""
        try:
            client = self._ensure_client()
            if unfollow:
                await self._run(client.unfollow_user, user_id)
                return {"success": True, "user_id": user_id, "message": "取消关注成功"}
            else:
                await self._run(client.follow_user, user_id)
                return {"success": True, "user_id": user_id, "message": "关注成功"}
        except SessionExpiredError:
            self._reset_client()
            return {"success": False, "message": "Session已过期，需要重新登录。"}
        except XhsApiError as e:
            return {"success": False, "message": str(e)}

    # --- Comment management ---

    async def reply_comment(self, note_id: str, comment_id: str, content: str) -> dict:
        """Reply to an existing comment."""
        try:
            client = self._ensure_client()
            await self._run(client.reply_comment, note_id, comment_id, content)
            return {"success": True, "note_id": note_id, "comment_id": comment_id, "message": "回复成功"}
        except SessionExpiredError:
            self._reset_client()
            return {"success": False, "message": "Session已过期，需要重新登录。"}
        except XhsApiError as e:
            return {"success": False, "message": str(e)}

    async def delete_comment(self, note_id: str, comment_id: str) -> dict:
        """Delete a comment (must be own comment)."""
        try:
            client = self._ensure_client()
            await self._run(client.delete_comment, note_id, comment_id)
            return {"success": True, "note_id": note_id, "comment_id": comment_id, "message": "评论已删除"}
        except SessionExpiredError:
            self._reset_client()
            return {"success": False, "message": "Session已过期，需要重新登录。"}
        except XhsApiError as e:
            return {"success": False, "message": str(e)}

    # --- Notifications ---

    async def get_notifications(self, category: str = "likes", cursor: str = "") -> dict:
        """Get notifications. Category: likes, mentions, connections."""
        try:
            client = self._ensure_client()
            if category == "mentions":
                result = await self._run(client.get_notification_mentions, cursor)
            elif category == "connections":
                result = await self._run(client.get_notification_connections, cursor)
            else:
                result = await self._run(client.get_notification_likes, cursor)
            return {"success": True, "category": category, "data": result}
        except SessionExpiredError:
            self._reset_client()
            return {"success": False, "message": "Session已过期，需要重新登录。"}
        except XhsApiError as e:
            return {"success": False, "category": category, "message": str(e)}

    async def get_unread_count(self) -> dict:
        """Get unread notification counts."""
        try:
            client = self._ensure_client()
            result = await self._run(client.get_unread_count)
            return result
        except SessionExpiredError:
            self._reset_client()
            return {"error": "login_required", "message": "Session已过期，需要重新登录。"}
        except XhsApiError as e:
            return {"error": "api_error", "message": str(e)}

    # --- Hot feed ---

    async def get_hot_feed(self, category: str = "homefeed.fashion_v3") -> list | dict:
        """Get hot/trending feed by category."""
        try:
            client = self._ensure_client()
            result = await self._run(client.get_hot_feed, category)
            items = result.get("items", []) if isinstance(result, dict) else []
            feeds = []
            for item in items:
                feed = self._normalize_feed_item(item)
                if feed:
                    feeds.append(feed)
            return feeds
        except SessionExpiredError:
            self._reset_client()
            return {"error": "login_required", "message": "Session已过期，需要重新登录。"}
        except XhsApiError as e:
            return {"error": "api_error", "message": str(e)}

    # --- Delete note ---

    async def delete_note(self, note_id: str) -> dict:
        """Delete own note."""
        try:
            client = self._ensure_client()
            await self._run(client.delete_note, note_id)
            return {"success": True, "note_id": note_id, "message": "笔记已删除"}
        except SessionExpiredError:
            self._reset_client()
            return {"success": False, "message": "Session已过期，需要重新登录。"}
        except XhsApiError as e:
            return {"success": False, "message": str(e)}

    # --- Normalization helpers ---

    def _normalize_search_item(self, item: dict) -> dict | None:
        """Normalize a search result item to standard feed format."""
        note_card = item.get("note_card") or {}
        if not note_card:
            return None

        feed_id = item.get("id") or ""
        if not feed_id:
            return None

        xsec_token = item.get("xsec_token") or ""
        title = note_card.get("display_title") or note_card.get("title") or ""
        desc = note_card.get("desc") or ""
        note_type = note_card.get("type") or ""

        user = note_card.get("user") or {}
        author = user.get("nickname") or user.get("nick_name") or ""
        user_id = user.get("user_id") or ""

        interact = note_card.get("interact_info") or {}
        liked_count = interact.get("liked_count") or "0"

        cover = note_card.get("cover") or {}
        cover_url = self._extract_cover_url(cover)

        return {
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

    def _normalize_feed_item(self, item: dict) -> dict | None:
        """Normalize a home feed item."""
        note_card = item.get("note_card") or {}
        feed_id = item.get("id") or ""
        if not feed_id:
            return None

        xsec_token = item.get("xsec_token") or ""
        title = note_card.get("display_title") or note_card.get("title") or ""
        note_type = note_card.get("type") or ""

        user = note_card.get("user") or {}
        author = user.get("nickname") or ""
        user_id = user.get("user_id") or ""

        interact = note_card.get("interact_info") or {}
        liked_count = interact.get("liked_count") or "0"

        cover = note_card.get("cover") or {}
        cover_url = self._extract_cover_url(cover)

        return {
            "feed_id": feed_id,
            "xsec_token": xsec_token,
            "title": title,
            "type": "video" if note_type == "video" else "image",
            "author": author,
            "user_id": user_id,
            "likes": str(liked_count),
            "cover": cover_url,
        }

    def _normalize_note_detail(self, result: dict) -> dict:
        """Normalize get_note_detail result to standard detail format."""
        # xhs_cli returns {"items": [{"note_card": {...}, ...}]} for feed API
        # or {"title": ..., "desc": ...} for HTML fallback
        items = result.get("items", [])
        if items:
            item = items[0]
            note = item.get("note_card") or item
        else:
            note = result

        title = note.get("title") or note.get("display_title") or ""
        desc = note.get("desc") or ""
        note_type = note.get("type") or ""

        user = note.get("user") or {}
        author = user.get("nickname") or user.get("nick_name") or ""
        user_id = user.get("user_id") or ""

        interact = note.get("interact_info") or {}
        detail = {
            "title": title,
            "content": desc,
            "type": note_type,
            "author": author,
            "user_id": user_id,
            "interactions": {
                "likes": str(interact.get("liked_count") or "0"),
                "favorites": str(interact.get("collected_count") or "0"),
                "comments": str(interact.get("comment_count") or "0"),
                "shares": str(interact.get("share_count") or "0"),
            },
        }

        # Images
        image_list = note.get("image_list") or []
        detail["images"] = []
        for img in image_list:
            info_list = img.get("info_list") or []
            if info_list:
                detail["images"].append(info_list[-1].get("url") or "")
            elif img.get("url"):
                detail["images"].append(img["url"])

        # Tags
        tag_list = note.get("tag_list") or []
        detail["tags"] = [t.get("name") or "" for t in tag_list if isinstance(t, dict)]

        # Time
        detail["time"] = note.get("time") or note.get("create_time") or ""
        detail["last_update_time"] = note.get("last_update_time") or ""

        return detail

    @staticmethod
    def _extract_cover_url(cover: dict) -> str:
        """Extract best cover URL from cover dict."""
        if not isinstance(cover, dict):
            return ""
        info_list = cover.get("info_list") or []
        if info_list:
            return info_list[-1].get("url") or ""
        return cover.get("url") or cover.get("url_default") or ""
