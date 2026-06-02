"""Register all xiaohongshu MCP tools."""

import json
import logging
from typing import Optional

from mcp.server.fastmcp import FastMCP

from xhs_browser import XhsBrowser

logger = logging.getLogger("xiaohongshu-mcp")


def register_tools(mcp: FastMCP, browser: XhsBrowser):
    """Register all tool handlers on the MCP server."""

    @mcp.tool()
    async def xhs_check_login() -> str:
        """检查小红书登录状态。返回是否已登录及用户名。"""
        result = await browser.check_login()
        return json.dumps(result, ensure_ascii=False)

    @mcp.tool()
    async def xhs_get_qrcode() -> str:
        """获取小红书登录二维码。返回base64图片，用小红书App扫码登录。超时4分钟。"""
        result = await browser.get_qrcode()
        return json.dumps(result, ensure_ascii=False)

    @mcp.tool()
    async def xhs_delete_cookies() -> str:
        """删除保存的cookies，重置登录状态。删除后需重新扫码登录。"""
        await browser.delete_cookies()
        return json.dumps({"success": True, "message": "Cookies已删除，需重新登录"}, ensure_ascii=False)

    @mcp.tool()
    async def xhs_search(
        keyword: str,
        sort_by: str = "综合",
        note_type: str = "不限",
        publish_time: str = "不限",
    ) -> str:
        """搜索小红书内容。

        Args:
            keyword: 搜索关键词
            sort_by: 排序方式 (综合/最新/最多点赞)
            note_type: 笔记类型 (不限/视频/图文)
            publish_time: 发布时间 (不限/一天内/一周内/半年内)
        """
        filters = {}
        if sort_by != "综合":
            filters["sort_by"] = sort_by
        if note_type != "不限":
            filters["note_type"] = note_type
        if publish_time != "不限":
            filters["publish_time"] = publish_time

        feeds = await browser.search_feeds(keyword, filters if filters else None)
        if isinstance(feeds, dict) and feeds.get("error"):
            return json.dumps(feeds, ensure_ascii=False)
        return json.dumps(
            {"keyword": keyword, "count": len(feeds), "feeds": feeds},
            ensure_ascii=False,
        )

    @mcp.tool()
    async def xhs_list_feed() -> str:
        """获取小红书首页推荐Feed列表。需要已登录。"""
        feeds = await browser.list_feeds()
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
        detail = await browser.get_post_detail(feed_id, xsec_token, load_comments)
        return json.dumps(detail, ensure_ascii=False)

    @mcp.tool()
    async def xhs_like(
        feed_id: str,
        xsec_token: str = "",
        unlike: bool = False,
    ) -> str:
        """点赞或取消点赞小红书笔记。

        Args:
            feed_id: 笔记ID
            xsec_token: 访问令牌（可选）
            unlike: 是否取消点赞 (默认false即点赞)
        """
        result = await browser.like_feed(feed_id, xsec_token, unlike)
        return json.dumps(result, ensure_ascii=False)

    @mcp.tool()
    async def xhs_favorite(
        feed_id: str,
        xsec_token: str = "",
        unfavorite: bool = False,
    ) -> str:
        """收藏或取消收藏小红书笔记。

        Args:
            feed_id: 笔记ID
            xsec_token: 访问令牌（可选）
            unfavorite: 是否取消收藏 (默认false即收藏)
        """
        result = await browser.favorite_feed(feed_id, xsec_token, unfavorite)
        return json.dumps(result, ensure_ascii=False)

    @mcp.tool()
    async def xhs_comment(
        feed_id: str,
        content: str,
        xsec_token: str = "",
    ) -> str:
        """在小红书笔记下发表评论。

        Args:
            feed_id: 笔记ID
            content: 评论内容
            xsec_token: 访问令牌（可选）
        """
        result = await browser.post_comment(feed_id, xsec_token, content)
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
            visibility: 可见范围 (公开可见/仅自己可见/仅互关好友可见)
        """
        result = await browser.publish_content(title, content, images, tags, visibility)
        return json.dumps(result, ensure_ascii=False)
