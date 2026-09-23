import { api, describeError } from "./api.js";
import { toast } from "./toast.js";
import { setTheme } from "./theme.js";

/** Single app-wide store. Views mutate it through the exported actions and the
 *  shell re-renders from the resulting snapshot. */
export const state = {
  ready: false,
  version: "",
  startupError: null,
  hasVault: false,
  mode: null,
  hint: "",
  portable: false,
  locked: true,
  lockedReason: "",
  view: "accounts",
  categoryId: "sap",
  search: "",
  vault: null,
  settings: null,
  presets: [],
  paths: null,
  selectedEntryId: null,
  selectedEntry: null,

  assocFilter: "",
  assocOnlyLinked: false,
  assocMode: "cards",
  syncSelection: null,
  /** Filter for the key list of the selected sync file (Ctrl+K). */
  syncKeyFilter: "",
  filePlans: {},
  /** Which tree branches are open, per file id and key path. */
  treeOpen: {},
  refreshing: false,
  /** True while files are being dragged over the sync view. */
  dragActive: false,
  /** Parsed SAP Logon configuration (systems we can start). */
  landscape: null,
  /** Where sapshcut.exe lives and how the password travels. */
  guiStatus: null,
};

const listeners = new Set();

export function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function emit() {
  for (const listener of listeners) listener(state);
}

export function setState(patch) {
  Object.assign(state, patch);
  emit();
}

export function touch() {
  emit();
}

// --------------------------------------------------------------- lifecycle --

export async function bootstrap() {
  const info = await api.bootstrap();
  setTheme(info.settings.theme);
  setState({
    ready: true,
    version: info.version,
    startupError: info.startupError ?? null,
    hasVault: info.hasVault,
    mode: info.mode,
    hint: info.hint,
    portable: info.portable,
    locked: true,
    settings: info.settings,
    presets: info.presets,
    paths: {
      dataDir: info.dataDir,
      vaultPath: info.vaultPath,
      supportedFormats: info.supportedFormats,
    },
  });
  // SAP Logon is optional (SAP GUI may not be installed), so a failure here
  // must never keep the app from starting.
  await Promise.all([refreshLandscape(), refreshGuiStatus()]).catch(() => {});
}

// -------------------------------------------------------------------- SAP --

/** Re-reads `SAPUILandscape*.xml` (the user may have added a system meanwhile). */
export async function refreshLandscape() {
  const landscape = await api.sapRefreshLandscape();
  setState({ landscape });
  return landscape;
}

export async function refreshGuiStatus() {
  const guiStatus = await api.sapGuiStatus();
  setState({ guiStatus });
  return guiStatus;
}

/** Starts SAP GUI for one account. */
export async function launchSap(id) {
  const outcome = await api.sapLaunch(id);
  toast(outcome?.message ?? "已启动 SAP GUI", "success");
  return outcome;
}

/** Writes a `.sap` shortcut next to wherever the user points the dialog. */
export async function exportSapShortcut(id, path) {
  const saved = await api.sapExportShortcut(id, path);
  toast(`快捷方式已保存到 ${saved}`, "success");
  return saved;
}

export async function createVault(mode, password, hint) {
  await api.vaultCreate(mode, password || null, hint || "");
  setState({
    hasVault: true,
    mode,
    hint: hint || "",
    locked: false,
    lockedReason: "",
    startupError: null,
  });
  await refreshVault();
  toast("保险库已创建，可以开始添加账号", "success");
}

export async function unlock(password) {
  const view = await api.vaultUnlock(password || null);
  setState({ locked: false, lockedReason: "", vault: view });
  toast("保险库已解锁", "success");
}

export async function lock(reason = "") {
  if (state.locked) return;
  await api.vaultLock();
  applyLockedState(reason);
}

export function handleLocked(reason) {
  if (state.locked) return;
  applyLockedState(reason);
  toast(reason === "session" ? "检测到系统锁屏，已自动锁定" : "已自动锁定", "info");
}

function applyLockedState(reason) {
  setState({
    locked: true,
    lockedReason: reason ?? "",
    vault: null,
    selectedEntry: null,
    selectedEntryId: null,
    syncSelection: null,
    filePlans: {},
  });
}

// ------------------------------------------------------------------- vault --

export async function refreshVault() {
  setState({ refreshing: true });
  try {
    const vault = await api.vaultView();
    const stillThere =
      !state.selectedEntryId ||
      vault.entries.some((entry) => entry.id === state.selectedEntryId);
    setState({
      vault,
      refreshing: false,
      selectedEntryId: stillThere ? state.selectedEntryId : null,
      selectedEntry: stillThere ? state.selectedEntry : null,
    });
  } catch (error) {
    setState({ refreshing: false });
    throw error;
  }
}

export async function selectEntry(id) {
  setState({ selectedEntryId: id, selectedEntry: null });
  if (!id) return;
  const entry = await api.entryGet(id);
  if (state.selectedEntryId === id) setState({ selectedEntry: entry });
}

export async function setKnoxId(value) {
  const vault = await api.knoxSet(value);
  setState({ vault });
}

/** Saves an entry. Validation problems (rule / cycle) are re-thrown with their
 *  details so the editor can offer an explicit override. */
export async function saveEntry(input) {
  const saved = await api.entrySave(input);
  await refreshVault();
  await selectEntry(saved.id);
  return saved;
}

export async function deleteEntry(id) {
  const vault = await api.entryDelete(id);
  setState({ vault, selectedEntryId: null, selectedEntry: null });
}

export async function toggleFavorite(id) {
  const vault = await api.entryFavorite(id);
  setState({ vault });
}

// --------------------------------------------------------------- clipboard --

export async function copyPassword(id) {
  toast(await api.copyPassword(id), "success");
}

export async function copyUsername(id) {
  toast(await api.copyUsername(id), "success");
}

export async function copySap(id) {
  toast(await api.copySap(id), "success");
}

export async function copyText(value, label) {
  toast(await api.copyText(value, label), "success");
}

// ---------------------------------------------------------------- settings --

export async function saveSettings(patch) {
  const next = { ...state.settings, ...patch };
  const saved = await api.settingsSave(next);
  setTheme(saved.theme);
  setState({ settings: saved });
  return saved;
}


// ------------------------------------------------------------------- files --

/** Registers uploaded files and optionally binds them to accounts. */
export async function addFiles(drafts) {
  const vault = await api.fileAdd(drafts);
  setState({ vault });
  toast(`已上传 ${drafts.length} 个文件`, "success");
  return vault;
}

export async function updateFileKeys(fileId, keys) {
  const vault = await api.fileUpdateKeys(fileId, keys);
  setState({ vault });
  toast("关键词已更新并重新检测", "success");
  return vault;
}

export async function reanalyzeFile(fileId) {
  const vault = await api.fileReanalyze(fileId);
  setState({ vault });
  return vault;
}

export async function bindFile(fileId, bindings) {
  const vault = await api.fileBind(fileId, bindings);
  setState({ vault });
  return vault;
}

export async function removeFile(fileId) {
  const vault = await api.fileRemove(fileId);
  setState({ vault, filePlans: {}, syncSelection: null });
  toast("已移除文件", "success");
  return vault;
}

/** Every uploaded file that has at least one key bound to this account. */
export function filesForEntry(entryId) {
  return (state.vault?.files ?? []).filter((file) =>
    (file.bindings ?? []).some((binding) => binding.entryId === entryId),
  );
}

/** The keys of one account inside one file. */
export function bindingsFor(entryId, file) {
  return (file.bindings ?? []).filter((binding) => binding.entryId === entryId);
}

/** Plans for every file, keyed by file id (shown in the sync view). */
export async function loadFilePlans() {
  const plans = await api.filePlans();

  const keyed = {};
  for (const plan of plans) keyed[plan.fileId] = plan;
  setState({ filePlans: keyed });
  return keyed;
}

export async function syncFile(fileId) {
  const outcome = await api.fileSync(fileId);
  await refreshVault();
  await loadFilePlans();
  toast(
    outcome.changed ? `${outcome.status}：${outcome.path}` : `${outcome.path}：${outcome.status}`,
    outcome.changed ? "success" : "info",
  );
  return outcome;
}

/** Syncs the given files in one go and reports a single summary. */
export async function syncFiles(fileIds) {
  const outcomes = [];
  for (const id of fileIds) {
    outcomes.push(await api.fileSync(id));
  }
  await refreshVault();
  await loadFilePlans();
  const updated = outcomes.reduce((sum, outcome) => sum + outcome.updates, 0);
  toast(
    outcomes.length
      ? `同步完成：${outcomes.length} 个文件，更新 ${updated} 处密码`
      : "没有需要同步的文件",
    updated ? "success" : "info",
  );
  return outcomes;
}

export async function syncAllFiles() {
  const outcomes = await api.fileSyncAll();
  await refreshVault();
  await loadFilePlans();
  const updated = outcomes.reduce((sum, outcome) => sum + outcome.updates, 0);
  toast(
    outcomes.length
      ? `同步完成：${outcomes.length} 个文件，更新 ${updated} 处密码`
      : "没有可同步的文件",
    outcomes.length ? "success" : "info",
  );
  return outcomes;
}

// ----------------------------------------------------------------- history --

async function withEntry(entryId, promise) {
  const entry = await promise;
  await refreshVault();
  if (state.selectedEntryId === entryId) setState({ selectedEntry: entry });
  return entry;
}

export function addHistory(entryId, password, note) {
  return withEntry(entryId, api.historyAdd(entryId, password, note));
}

export function removeHistory(entryId, historyId) {
  return withEntry(entryId, api.historyRemove(entryId, historyId));
}

export function clearHistory(entryId) {
  return withEntry(entryId, api.historyClear(entryId));
}

// -------------------------------------------------------------------- sync --



export function navigate(view, patch = {}) {
  setState({ view, ...patch });
}

export { describeError };
