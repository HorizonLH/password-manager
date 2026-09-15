import { h, guard, mount } from "../dom.js";
import { icon } from "../icons.js";
import { api } from "../api.js";
import {
  state,
  selectEntry,
  copyPassword,
  copyUsername,
  copySap,
  copyText,
  toggleFavorite,
  removeLink,
  reanalyzeLink,
  removeHistory,
} from "../state.js";
import { openModal } from "../modal.js";
import { toast } from "../toast.js";
import {
  FIELD_LABELS,
  FIELD_ORDER,
  formatBytes,
  formatLabel,
  formatTime,
  mask,
  shortSid,
} from "../format.js";
import { openEntryEditor } from "./editor.js";
import { openKeyEditor, openLinkDialog } from "./linkkeys.js";

/** List rows carry `systemId` directly; a full entry nests it under `sap`. */
const sidOf = (entry) => entry.sap?.systemId ?? entry.systemId ?? "";

function filterEntries() {
  const term = state.search.trim().toLowerCase();
  return (state.vault?.entries ?? []).filter((entry) => {
    if (state.categoryId !== "all" && entry.categoryId !== state.categoryId) return false;
    if (!term) return true;
    return [entry.title, entry.username, entry.systemId, entry.client, entry.url]
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
        entry.linkCount ? h("span", { class: "row__sep" }, "·") : null,
        entry.linkCount
          ? h(
              "span",
              { class: "tag" },
              icon("link", { size: 11 }),
              `${entry.linkCount} 个文件`,
            )
          : null,
        entry.historyCycle
          ? h("span", { class: "tag tag--mono" }, `循环 ${entry.historyCycle}`)
          : null,
        entry.hasRule ? h("span", { class: "tag" }, "有规则") : null,
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
      sidOf(entry)
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

/** What the attached files contributed for this account. */
function parsedFields(entry) {
  return FIELD_ORDER.map((kind) => {
    for (const link of entry.links ?? []) {
      const hit = (link.parse?.fields ?? []).find((field) => field.kind === kind);
      if (hit && hit.value) return { kind, value: hit.value };
    }
    return { kind, value: "" };
  });
}

function linkCard(entry, link) {
  const parse = link.parse ?? { format: "text", fields: [], missing: [...FIELD_ORDER] };
  const missing = parse.missing ?? [];

  return h(
    "div",
    { class: "stack stack--tight" },
    h(
      "div",
      { class: "assoc__file" },
      icon(link.exists ? "file" : "alert", { size: 14 }),
      h("span", { class: "assoc__file-path", title: link.path }, link.path),
      h("span", { class: "tag tag--accent" }, formatLabel(parse.format)),
      link.exists
        ? h("span", { class: "tag tag--mono" }, formatBytes(link.size))
        : h("span", { class: "tag tag--danger" }, "文件不存在"),
      missing.length
        ? h("span", { class: "tag tag--warn" }, `缺少 ${missing.length} 个字段`)
        : h("span", { class: "tag tag--success" }, "字段完整"),
      h(
        "button",
        {
          class: "btn btn--icon btn--sm",
          type: "button",
          title: "关键词 / 重新检测",
          onClick: () => openKeyEditor({ entry, link }),
        },
        icon("sliders", { size: 13 }),
      ),
      h(
        "button",
        {
          class: "btn btn--icon btn--sm",
          type: "button",
          title: "重新检测",
          onClick: guard(async () => {
            await reanalyzeLink(entry.id, link.id);
            toast("已重新检测", "success");
          }),
        },
        icon("refresh", { size: 13 }),
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
          title: "解除关联",
          onClick: guard(async () => {
            await removeLink(entry.id, link.id);
            toast("已解除关联", "success");
          }),
        },
        icon("x", { size: 13 }),
      ),
    ),
    h(
      "div",
      { class: "evidence" },
      ...FIELD_ORDER.map((kind) => {
        const hit = (parse.fields ?? []).find((field) => field.kind === kind);
        if (!hit) {
          return h(
            "div",
            { class: "evidence__row" },
            h("span", { class: "field__label" }, FIELD_LABELS[kind]),
            h("span", { class: "tag tag--warn" }, "未识别"),
          );
        }
        return h(
          "div",
          { class: "evidence__row" },
          h("span", { class: "field__label" }, FIELD_LABELS[kind]),
          h(
            "span",
            { class: "field__text" },
            kind === "password" ? mask(hit.value, false) : hit.value,
          ),
          h("span", { class: "tag tag--mono" }, `键 ${hit.key}`),
          h(
            "button",
            {
              class: "btn btn--icon btn--sm",
              type: "button",
              title: `复制${FIELD_LABELS[kind]}`,
              onClick: guard(() => copyText(hit.value, FIELD_LABELS[kind])),
            },
            icon("copy", { size: 12 }),
          ),
        );
      }),
    ),
  );
}

function historySection(entry) {
  let revealed = new Set();
  const list = h("div", { class: "stack stack--tight" });
  let expanded = false;

  const toggle = h(
    "button",
    {
      class: "btn btn--ghost btn--sm",
      type: "button",
      onClick: () => {
        expanded = !expanded;
        paint();
      },
    },
    icon(expanded ? "chevronDown" : "chevronRight", { size: 13 }),
    expanded ? "收起" : `查看 ${entry.passwordHistory.length} 个历史密码`,
  );

  function paint() {
    mount(
      list,
      toggle,
      expanded
        ? h(
            "div",
            { class: "stack stack--tight" },
            entry.passwordHistory.map((item, index) =>
              h(
                "div",
                { class: "assoc__file" },
                h(
                  "span",
                  { class: "tag tag--mono" },
                  entry.historyCycle > 0 && index < entry.historyCycle ? "循环内" : "更早",
                ),
                h(
                  "span",
                  { class: "field__text", style: { flex: "1" } },
                  revealed.has(item.id) ? item.password : mask(item.password, false),
                ),
                h("span", { class: "subtle" }, item.note || formatTime(item.recordedAt)),
                h(
                  "button",
                  {
                    class: "btn btn--icon btn--sm",
                    type: "button",
                    title: "显示 / 隐藏",
                    onClick: () => {
                      if (revealed.has(item.id)) revealed.delete(item.id);
                      else revealed.add(item.id);
                      paint();
                    },
                  },
                  icon(revealed.has(item.id) ? "eyeOff" : "eye", { size: 13 }),
                ),
                h(
                  "button",
                  {
                    class: "btn btn--icon btn--sm",
                    type: "button",
                    title: "复制该历史密码",
                    onClick: guard(() => copyText(item.password, "历史密码")),
                  },
                  icon("copy", { size: 13 }),
                ),
                h(
                  "button",
                  {
                    class: "btn btn--icon btn--sm",
                    type: "button",
                    title: "删除",
                    onClick: guard(async () => {
                      await removeHistory(entry.id, item.id);
                    }),
                  },
                  icon("x", { size: 13 }),
                ),
              ),
            ),
          )
        : null,
    );
  }

  paint();
  return list;
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

  const parseState = parsedFields(entry);

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
        sidOf(entry) ? h("span", { class: "tag tag--accent" }, sidOf(entry)) : null,
        entry.client ? h("span", { class: "tag tag--mono" }, `客户端 ${entry.client}`) : null,
        entry.language ? h("span", { class: "tag tag--mono" }, entry.language) : null,
        entry.useKnoxId ? h("span", { class: "tag tag--accent" }, "Knox ID") : null,
        entry.favorite ? h("span", { class: "tag" }, "已收藏") : null,
      ),
    ),
    h(
      "div",
      { class: `copy-row${sidOf(entry) ? "" : " copy-row--single"}` },
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
      sidOf(entry)
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
    h(
      "div",
      { class: "detail__section" },
      h(
        "div",
        { class: "detail__section-head" },
        h("div", { class: "section-title" }, icon("sliders", { size: 12 }), "密码规则"),
        h(
          "span",
          { class: "tag" },
          entry.rule?.enabled ? "已启用" : "未设置",
        ),
      ),
      h(
        "p",
        { class: "form__hint" },
        entry.rule?.enabled
          ? describeRule(entry.rule)
          : "该条目没有规则，任何密码都会被接受。可在编辑条目时添加。",
      ),
    ),
    h(
      "div",
      { class: "detail__section" },
      h(
        "div",
        { class: "detail__section-head" },
        h(
          "div",
          { class: "section-title" },
          icon("clock", { size: 12 }),
          "密码循环",
        ),
        h(
          "span",
          { class: "tag tag--mono" },
          entry.historyCycle > 0 ? `禁止重复最近 ${entry.historyCycle} 个` : "不校验重复",
        ),
      ),
      entry.passwordHistory.length
        ? historySection(entry)
        : h("p", { class: "form__hint" }, "还没有历史密码；修改密码时会自动记录。"),
    ),
    parseState.some((item) => item.value)
      ? h(
          "div",
          { class: "detail__section" },
          h(
            "div",
            { class: "section-title" },
            icon("filter", { size: 12 }),
            "从关联文件解析到的字段",
          ),
          h(
            "div",
            { class: "stack stack--tight" },
            parseState.map((item) =>
              h(
                "div",
                { class: "field" },
                h("span", { class: "field__label" }, FIELD_LABELS[item.kind]),
                h(
                  "span",
                  { class: "field__value" },
                  h(
                    "span",
                    { class: "field__text" },
                    item.kind === "password" ? mask(item.value, false) : item.value,
                  ),
                  h(
                    "button",
                    {
                      class: "btn btn--icon btn--sm",
                      type: "button",
                      title: `复制${FIELD_LABELS[item.kind]}`,
                      onClick: guard(() => copyText(item.value, FIELD_LABELS[item.kind])),
                    },
                    icon("copy", { size: 12 }),
                  ),
                ),
              ),
            ),
          ),
        )
      : null,
    entry.hosts?.length
      ? h(
          "div",
          { class: "detail__section" },
          h("div", { class: "section-title" }, icon("server", { size: 12 }), "登录配置中的主机"),
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
              openLinkDialog({ entryId: entry.id, paths: picked });
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
            entry.links.map((link) => linkCard(entry, link)),
          )
        : h(
            "p",
            { class: "form__hint" },
            "还没有关联文件。点击「添加文件」选择 JSON、.env、TOML、YAML、XML 或纯文本文件，SapVault 会自动找出 URL、用户名与密码。",
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

function describeRule(rule) {
  const classes = [];
  if (rule.lower) classes.push("小写");
  if (rule.upper) classes.push("大写");
  if (rule.digits) classes.push("数字");
  if (rule.symbols) classes.push("符号");
  const parts = [`${rule.minLength}-${rule.maxLength} 位`, classes.join("+") || "无字符集"];
  if (rule.forbidden) parts.push(`禁用 ${rule.forbidden}`);
  if (rule.startWithLetter) parts.push("首字符为字母");
  if (rule.description) parts.unshift(rule.description);
  return parts.join(" · ");
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
              : "点击右上角「新建条目」，SAP 账号会自动关联系统 ID 与登录配置中的主机名。",
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
          "详情面板提供复制密码、SAP 换行凭据、密码规则与循环历史，以及关联文件的解析结果。",
        ),
      ),
    );
  }
}
