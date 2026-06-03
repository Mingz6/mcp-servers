"""Register all xiaohongshu MCP tools."""

import json
import logging
from typing import Optional

from mcp.server.fastmcp import FastMCP

from xhs_client import XhsApiClient

logger = logging.getLogger("xiaohongshu-mcp")


def register_tools(mcp: FastMCP, client: XhsApiClient):
    """Register all tool handlers on the MCP server."""

    @mcp.tool()
    async def xhs_check_login() -> str:
        """检查小红书登录状态。返回是否已登录及用户名。"""
        result = await client.check_login()
        return json.dumps(result, ensure_ascii=False)

    @mcp.tool()
    async def xhs_get_qrcode() -> str:
        """获取小红书登录二维码。返回QR URL，用小红书App扫码登录。"""
        result = await client.get_qrcode()
        return json.dumps(result, ensure_ascii=False)

    @mcp.tool()
    async def xhs_delete_cookies() -> str:
        """删除保存的cookies，重置登录状态。删除后需重新扫码登录。"""
        await client.delete_cookies()
        return json.dumps({"success": True, "message": "Cookies已删除，需重新登录"}, ensure_ascii=False)

    @mcp.tool()
    async def xhs_search(
        keyword: str,
        sort_by: str = "综合",
        note_type: str = "不限",
        page: int = 1,
    ) -> str:
        """搜索小红书内容。

        Args:
            keyword: 搜索关键词
            sort_by: 排序方式 (综合/最新/最多点赞)
            note_type: 笔记类型 (不限/视频/图文)
            page: 页码 (默认1)
        """
        feeds = await client.search(keyword, sort_by=sort_by, note_type=note_type, page=page)
        if isinstance(feeds, dict) and feeds.get("error"):
            return json.dumps(feeds, ensure_ascii=False)
        return json.dumps(
            {"keyword": keyword, "count": len(feeds), "feeds": feeds},
            ensure_ascii=False,
        )

    @mcp.tool()
    async def xhs_list_feed() -> str:
        """获取小红书首页推荐Feed列表。需要已登录。"""
        feeds = await client.list_feed()
        if isinstance(feeds, dict) and feeds.get("error"):
            return json.dumps(feeds, ensure_ascii=False)
        return json.dumps(
            {"count": len(feeds), "feeds": feeds}, ensure_ascii=False
        )

    @mcp.tool()
    async def xhs_get_post_detail(
        feed_id: str,
        xsec_token: str = "",
        load_comments: bool = False,
    ) -> str:
        """获取小红书笔记详情。

        Args:
            feed_id: 笔记ID，从搜索或Feed列表获取
            xsec_token: 访问令牌，从Feed列表获取（可选）
            load_comments: 是否加载评论 (默认false)
        """
        detail = await client.get_post_detail(feed_id, xsec_token, load_comments)
        return json.dumps(detail, ensure_ascii=False)

    @mcp.tool()
    async def xhs_like(
        feed_id: str,
        unlike: bool = False,
    ) -> str:
        """点赞或取消点赞小红书笔记。

        Args:
            feed_id: 笔记ID
            unlike: 是否取消点赞 (默认false即点赞)
        """
        result = await client.like(feed_id, unlike)
        return json.dumps(result, ensure_ascii=False)

    @mcp.tool()
    async def xhs_favorite(
        feed_id: str,
        unfavorite: bool = False,
    ) -> str:
        """收藏或取消收藏小红书笔记。

        Args:
            feed_id: 笔记ID
            unfavorite: 是否取消收藏 (默认false即收藏)
        """
        result = await client.favorite(feed_id, unfavorite)
        return json.dumps(result, ensure_ascii=False)

    @mcp.tool()
    async def xhs_comment(
        feed_id: str,
        content: str,
    ) -> str:
        """在小红书笔记下发表评论。

        Args:
            feed_id: 笔记ID
            content: 评论内容
        """
        result = await client.post_comment(feed_id, content)
        return json.dumps(result, ensure_ascii=False)

    @mcp.tool()
    async def xhs_publish(
        title: str,
        content: str,
        images: list[str],
        tags: Optional[list[str]] = None,
        visibility: str = "公开可见",
    ) -> str:
        """发布小红书图文内容。

        Args:
            title: 标题（最多20个中文字）
            content: 正文内容
            images: 本地图片路径列表（至少1张）
            tags: 话题标签列表（可选），如 ["美食", "旅行"]
            visibility: 可见范围 (公开可见/仅自己可见)
        """
        is_private = visibility != "公开可见"
        result = await client.publish(title, content, images, tags, is_private)
        return json.dumps(result, ensure_ascii=False)

    # --- Social tools ---

    @mcp.tool()
    async def xhs_search_users(keyword: str) -> str:
        """搜索小红书用户。

        Args:
            keyword: 搜索关键词（用户名、昵称等）
        """
        result = await client.search_users(keyword)
        return json.dumps(result, ensure_ascii=False)

    @mcp.tool()
    async def xhs_get_user_info(user_id: str) -> str:
        """查看某个用户的个人资料。

        Args:
            user_id: 用户ID
        """
        result = await client.get_user_info(user_id)
        return json.dumps(result, ensure_ascii=False)

    @mcp.tool()
    async def xhs_get_user_notes(user_id: str, cursor: str = "") -> str:
        """查看某个用户发布的笔记列表。

        Args:
            user_id: 用户ID
            cursor: 分页游标（留空获取第一页）
        """
        result = await client.get_user_notes(user_id, cursor)
        return json.dumps(result, ensure_ascii=False)

    @mcp.tool()
    async def xhs_follow(user_id: str) -> str:
        """关注某个小红书用户。

        Args:
            user_id: 要关注的用户ID
        """
        result = await client.follow_user(user_id, unfollow=False)
        return json.dumps(result, ensure_ascii=False)

    @mcp.tool()
    async def xhs_unfollow(user_id: str) -> str:
        """取消关注某个小红书用户。

        Args:
            user_id: 要取消关注的用户ID
        """
        result = await client.follow_user(user_id, unfollow=True)
        return json.dumps(result, ensure_ascii=False)

    # --- Comment management tools ---

    @mcp.tool()
    async def xhs_reply_comment(
        feed_id: str,
        comment_id: str,
        content: str,
    ) -> str:
        """回复小红书笔记下的某条评论。

        Args:
            feed_id: 笔记ID
            comment_id: 要回复的评论ID
            content: 回复内容
        """
        result = await client.reply_comment(feed_id, comment_id, content)
        return json.dumps(result, ensure_ascii=False)

    @mcp.tool()
    async def xhs_delete_comment(feed_id: str, comment_id: str) -> str:
        """删除自己发表的评论。

        Args:
            feed_id: 笔记ID
            comment_id: 评论ID
        """
        result = await client.delete_comment(feed_id, comment_id)
        return json.dumps(result, ensure_ascii=False)

    # --- Notifications tools ---

    @mcp.tool()
    async def xhs_notifications(category: str = "likes", cursor: str = "") -> str:
        """查看小红书通知消息。

        Args:
            category: 通知类型 (likes=赞, mentions=@我的, connections=新粉丝/互动)
            cursor: 分页游标（留空获取最新）
        """
        result = await client.get_notifications(category, cursor)
        return json.dumps(result, ensure_ascii=False)

    @mcp.tool()
    async def xhs_unread_count() -> str:
        """查看未读通知数量。"""
        result = await client.get_unread_count()
        return json.dumps(result, ensure_ascii=False)

    # --- Hot feed tool ---

    @mcp.tool()
    async def xhs_hot_feed(category: str = "homefeed.fashion_v3") -> str:
        """获取小红书热门/推荐信息流。

        Args:
            category: 频道分类ID (如 homefeed.fashion_v3, homefeed.food_v3 等)
        """
        result = await client.get_hot_feed(category)
        return json.dumps(result, ensure_ascii=False)

    # --- Delete note tool ---

    @mcp.tool()
    async def xhs_delete_note(feed_id: str) -> str:
        """删除自己发布的笔记。

        Args:
            feed_id: 要删除的笔记ID
        """
        result = await client.delete_note(feed_id)
        return json.dumps(result, ensure_ascii=False)
