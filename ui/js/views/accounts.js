import { h, guard, mount } from "../dom.js";
import { icon } from "../icons.js";
import { api } from "../api.js";
import {
  state,
  selectEntry,
  copyPassword,
  copyUsername,
  copySap,
  toggleFavorite,
  addLinks,
  removeLink,
} from "../state.js";
import { confirmModal, openModal } from "../modal.js";
import { toast } from "../toast.js";
import { formatBytes, formatTime, mask, originLabel, shortSid } from "../format.js";
import { openEntryEditor } from "./editor.js";

function filterEntries() {
  const term = state.search.trim().toLowerCase();
  return (state.vault?.entries ?? []).filter((entry) => {
    if (state.categoryId !== "all" && entry.categoryId !== state.categoryId) return false;
    if (!term) return true;
    return [
      entry.title,
      entry.username,
      entry.systemId,
      entry.client,
      entry.url,
      ...(entry.hosts ?? []),
    ]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(term));
  });
}

function entryRow(entry) {
  const selected = state.selectedEntryId === entry.id;
  return h(
    "div",
    {
      class: `row${selected ? " is-selected" : ""}`,
      role: "button",
      tabindex: "0",
      onClick: guard(() => selectEntry(entry.id)),
      onKeydown: (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          guard(() => selectEntry(entry.id))();
        }
      },
    },
    h("span", { class: "row__badge" }, shortSid(entry.systemId || entry.title)),
    h(
      "span",
      { class: "row__body" },
      h(
        "span",
        { class: "row__title" },
        entry.title,
        entry.favorite ? icon("star", { size: 12, solid: true }) : null,
        entry.useKnoxId ? h("span", { class: "tag tag--accent" }, "Knox") : null,
      ),
      h(
        "span",
        { class: "row__meta" },
        h("span", { class: "mono" }, entry.username || "无用户名"),
        entry.client ? h("span", { class: "row__sep" }, "·") : null,
        entry.client ? h("span", null, `客户端 ${entry.client}`) : null,
        entry.hosts?.length ? h("span", { class: "row__sep" }, "·") : null,
        entry.hosts?.length ? h("span", { class: "nowrap" }, entry.hosts[0]) : null,
        entry.linkCount ? h("span", { class: "row__sep" }, "·") : null,
        entry.linkCount
          ? h(
              "span",
              { class: "tag" },
              icon("link", { size: 11 }),
              `${entry.linkCount} 个文件`,
            )
          : null,
      ),
    ),
    h(
      "span",
      { class: "row__actions" },
      h(
        "button",
        {
          class: "btn btn--icon btn--sm",
          type: "button",
          title: "复制密码",
          onClick: (event) => {
            event.stopPropagation();
            guard(() => copyPassword(entry.id))();
          },
        },
        icon("copy", { size: 14 }),
      ),
      entry.systemId
        ? h(
            "button",
            {
              class: "btn btn--icon btn--sm",
              type: "button",
              title: "复制用户名 + 密码（SAP 换行格式）",
              onClick: (event) => {
                event.stopPropagation();
                guard(() => copySap(entry.id))();
              },
            },
            icon("key", { size: 14 }),
          )
        : null,
      h(
        "button",
        {
          class: "btn btn--icon btn--sm",
          type: "button",
          title: entry.favorite ? "取消收藏" : "收藏",
          onClick: (event) => {
            event.stopPropagation();
            guard(() => toggleFavorite(entry.id))();
          },
        },
        icon("star", { size: 14, solid: entry.favorite }),
      ),
    ),
  );
}

/** Explains *why* the scanner believes a file belongs to this account. */
function evidenceBlock(link) {
  const evidence = link.evidence;
  if (!evidence) return null;
  const tokens = [
    evidence.host,
    evidence.systemId,
    evidence.username,
    ...(evidence.matched ?? []),
  ].filter(Boolean);
  const unique = [...new Set(tokens)];
  return h(
    "div",
    { class: "evidence" },
    h(
      "div",
      { class: "evidence__tokens" },
      unique.map((token) => h("span", { class: "tag tag--mono" }, token)),
      h(
        "span",
        { class: "tag tag--accent" },
        evidence.firstLine ? `第 ${evidence.firstLine} 行` : "位置未知",
      ),
    ),
    evidence.excerpt ? h("pre", { class: "evidence__excerpt" }, evidence.excerpt) : null,
  );
}

function linkRow(entry, link) {
  return h(
    "div",
    { class: "stack stack--tight" },
    h(
      "div",
      { class: "assoc__file" },
      icon(link.exists ? "file" : "alert", { size: 14 }),
      h("span", { class: "assoc__file-path", title: link.path }, link.path),
      h(
        "span",
        { class: `tag${link.origin === "scan" ? " tag--accent" : ""}` },
        originLabel(link.origin),
      ),
      link.exists
        ? h("span", { class: "tag tag--mono" }, formatBytes(link.size))
        : h("span", { class: "tag tag--danger" }, "文件不存在"),
      h(
        "button",
        {
          class: "btn btn--icon btn--sm",
          type: "button",
          title: "在资源管理器中显示",
          onClick: guard(() => api.openInExplorer(link.path)),
        },
        icon("external", { size: 13 }),
      ),
      h(
        "button",
        {
          class: "btn btn--icon btn--sm",
          type: "button",
          title: "预览内容",
          onClick: guard(async () => {
            const preview = await api.linkPreview(link.path, 4000);
            openModal({
              title: link.label,
              size: "wide",
              render: () =>
                h(
                  "div",
                  { class: "stack" },
                  h(
                    "div",
                    { class: "token-list" },
                    h("span", { class: "tag tag--mono" }, link.path),
                    h("span", { class: "tag" }, formatBytes(preview.size)),
                    preview.truncated ? h("span", { class: "tag tag--warn" }, "已截断") : null,
                  ),
                  h("pre", { class: "preview" }, preview.content),
                ),
            });
          }),
        },
        icon("eye", { size: 13 }),
      ),
      h(
        "button",
        {
          class: "btn btn--icon btn--sm",
          type: "button",
          title: "解除关联",
          onClick: guard(async () => {
            await removeLink(entry.id, link.id);
            toast("已解除关联", "success");
          }),
        },
        icon("x", { size: 13 }),
      ),
    ),
    link.origin === "scan" ? evidenceBlock(link) : null,
  );
}

function detailPane(entry) {
  let revealed = false;
  const passwordValue = h("span", { class: "secret__value" }, mask(entry.password, revealed));
  const revealButton = h(
    "button",
    {
      class: "btn btn--icon btn--sm",
      type: "button",
      title: "显示 / 隐藏",
      onClick: () => {
        revealed = !revealed;
        passwordValue.textContent = mask(entry.password, revealed);
        mount(revealButton, icon(revealed ? "eyeOff" : "eye", { size: 14 }));
      },
    },
    icon("eye", { size: 14 }),
  );

  return h(
    "div",
    { class: "detail" },
    h(
      "div",
      { class: "detail__identity" },
      h(
        "div",
        { class: "detail__title" },
        h("h2", { class: "detail__name" }, entry.title),
        h(
          "button",
          {
            class: "btn btn--icon",
            type: "button",
            title: "编辑",
            onClick: () => openEntryEditor({ entry }),
          },
          icon("pencil", { size: 15 }),
        ),
      ),
      h(
        "div",
        { class: "detail__tags" },
        entry.systemId ? h("span", { class: "tag tag--accent" }, entry.systemId) : null,
        entry.client ? h("span", { class: "tag tag--mono" }, `客户端 ${entry.client}`) : null,
        entry.language ? h("span", { class: "tag tag--mono" }, entry.language) : null,
        entry.useKnoxId ? h("span", { class: "tag tag--accent" }, "Knox ID") : null,
        entry.favorite ? h("span", { class: "tag" }, "已收藏") : null,
      ),
    ),
    h(
      "div",
      { class: `copy-row${entry.systemId ? "" : " copy-row--single"}` },
      h(
        "button",
        {
          class: "btn btn--soft",
          type: "button",
          onClick: guard(() => copyPassword(entry.id)),
        },
        icon("copy", { size: 14 }),
        "复制密码",
      ),
      entry.systemId
        ? h(
            "button",
            {
              class: "btn btn--primary",
              type: "button",
              title: "用户名与密码以换行分隔，可直接粘贴到 SAP 登录界面",
              onClick: guard(() => copySap(entry.id)),
            },
            icon("key", { size: 14 }),
            "复制用户名 + 密码",
          )
        : h(
            "button",
            {
              class: "btn",
              type: "button",
              onClick: guard(() => copyUsername(entry.id)),
            },
            icon("user", { size: 14 }),
            "复制用户名",
          ),
    ),
    h(
      "div",
      { class: "detail__section" },
      h("div", { class: "section-title" }, icon("user", { size: 12 }), "凭据"),
      h(
        "div",
        { class: "field" },
        h("span", { class: "field__label" }, "用户名"),
        h(
          "span",
          { class: "field__value" },
          h("span", { class: "field__text" }, entry.username || "—"),
          h(
            "span",
            { class: "field__actions" },
            h(
              "button",
              {
                class: "btn btn--icon btn--sm",
                type: "button",
                title: "复制用户名",
                onClick: guard(() => copyUsername(entry.id)),
              },
              icon("copy", { size: 13 }),
            ),
          ),
        ),
      ),
      h(
        "div",
        { class: "field" },
        h("span", { class: "field__label" }, "密码"),
        h(
          "span",
          { class: "field__value" },
          passwordValue,
          h(
            "span",
            { class: "field__actions" },
            revealButton,
            h(
              "button",
              {
                class: "btn btn--icon btn--sm",
                type: "button",
                title: "复制密码",
                onClick: guard(() => copyPassword(entry.id)),
              },
              icon("copy", { size: 13 }),
            ),
          ),
        ),
      ),
    ),
    entry.hosts?.length
      ? h(
          "div",
          { class: "detail__section" },
          h("div", { class: "section-title" }, icon("server", { size: 12 }), "可匹配主机"),
          h(
            "div",
            { class: "token-list" },
            entry.hosts.map((host) => h("span", { class: "token" }, host)),
          ),
        )
      : null,
    entry.url
      ? h(
          "div",
          { class: "detail__section" },
          h("div", { class: "section-title" }, icon("external", { size: 12 }), "链接"),
          h("span", { class: "field__text" }, entry.url),
        )
      : null,
    entry.notes
      ? h(
          "div",
          { class: "detail__section" },
          h("div", { class: "section-title" }, icon("file", { size: 12 }), "备注"),
          h("p", { style: { margin: "0", whiteSpace: "pre-wrap" } }, entry.notes),
        )
      : null,
    h(
      "div",
      { class: "detail__section" },
      h(
        "div",
        { class: "detail__section-head" },
        h(
          "div",
          { class: "section-title" },
          icon("link", { size: 12 }),
          `关联内容（${entry.links.length}）`,
        ),
        h(
          "button",
          {
            class: "btn btn--ghost btn--sm",
            type: "button",
            onClick: guard(async () => {
              const picked = await api.pickFiles();
              if (!picked.length) return;
              await addLinks(entry.id, picked);
            }),
          },
          icon("plus", { size: 13 }),
          "添加文件",
        ),
      ),
      entry.links.length
        ? h(
            "div",
            { class: "stack stack--tight" },
            entry.links.map((link) => linkRow(entry, link)),
          )
        : h(
            "p",
            { class: "form__hint" },
            "还没有关联文件。可以手动添加，或到“扫描文件”页按系统 ID 与用户名自动查找。",
          ),
    ),
    h(
      "div",
      { class: "detail__section" },
      h(
        "div",
        { class: "field field--plain" },
        h("span", { class: "field__label" }, "创建"),
        h("span", { class: "muted" }, formatTime(entry.createdAt)),
      ),
      h(
        "div",
        { class: "field field--plain" },
        h("span", { class: "field__label" }, "最近更新"),
        h("span", { class: "muted" }, formatTime(entry.updatedAt)),
      ),
      h(
        "div",
        { class: "field field--plain" },
        h("span", { class: "field__label" }, "最近复制"),
        h("span", { class: "muted" }, formatTime(entry.lastUsedAt)),
      ),
    ),
  );
}

/** Master/detail view for every entry, filtered by the selected category. */
export function renderAccounts(listHost, detailHost) {
  if (!state.vault) return;
  const entries = filterEntries();

  mount(
    listHost,
    entries.length
      ? h("div", { class: "list" }, entries.map(entryRow))
      : h(
          "div",
          { class: "empty" },
          h("div", { class: "empty__icon" }, icon("key", { size: 20 })),
          h(
            "h3",
            { class: "empty__title" },
            state.search ? "没有匹配的条目" : "这个分类还是空的",
          ),
          h(
            "p",
            { class: "empty__text" },
            state.search
              ? "试试其它关键字，或清空搜索框。"
              : "点击右上角「新建条目」；SAP 账号会自动关联系统 ID 与登录配置中的主机名。",
          ),
        ),
  );

  if (state.selectedEntry) {
    mount(detailHost, detailPane(state.selectedEntry));
  } else {
    mount(
      detailHost,
      h(
        "div",
        { class: "empty" },
        h("div", { class: "empty__icon" }, icon("shield", { size: 20 })),
        h("h3", { class: "empty__title" }, "选择左侧条目查看详情"),
        h(
          "p",
          { class: "empty__text" },
          "详情面板提供复制密码、复制 SAP 换行凭据，以及关联文件与匹配证据的管理。",
        ),
      ),
    );
  }
}
