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
  landscape: null,
  landscapeLoading: false,
  sapFilter: "",
  assocFilter: "",
  assocOnlyLinked: false,
  assocMode: "cards",
  syncSelectedId: null,
  syncDraft: null,
  syncPreview: null,
  refreshing: false,
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
      landscapeDefaults: info.landscapeDefaults,
      landscapePaths: info.landscapePaths,
      supportedFormats: info.supportedFormats,
    },
  });
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
    syncDraft: null,
    syncPreview: null,
    syncSelectedId: null,
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

// --------------------------------------------------------------- landscape --

export async function loadLandscape(refresh = false) {
  if (state.landscapeLoading) return state.landscape;
  setState({ landscapeLoading: true });
  try {
    const report = await api.sapSystems(refresh);
    setState({ landscape: report, landscapeLoading: false });
    return report;
  } catch (error) {
    setState({ landscapeLoading: false });
    throw error;
  }
}

// ------------------------------------------------------------------- links --

export async function updateLinkKeys(entryId, linkId, keys) {
  const entry = await api.linkUpdateKeys(entryId, linkId, keys);
  await refreshVault();
  if (state.selectedEntryId === entryId) setState({ selectedEntry: entry });
  toast("关键词已更新并重新检测", "success");
  return entry;
}

export async function reanalyzeLink(entryId, linkId) {
  const entry = await api.linkReanalyze(entryId, linkId);
  await refreshVault();
  if (state.selectedEntryId === entryId) setState({ selectedEntry: entry });
  return entry;
}

export async function removeLink(entryId, linkId) {
  const entry = await api.linkRemove(entryId, linkId);
  await refreshVault();
  if (state.selectedEntryId === entryId) setState({ selectedEntry: entry });
  return entry;
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

export async function selectSyncTarget(id) {
  const target = (state.vault?.syncTargets ?? []).find((item) => item.id === id);
  setState({
    syncSelectedId: id,
    syncDraft: target ? { ...target } : null,
    syncPreview: null,
  });
  if (!target) return;
  try {
    const preview = await api.syncPreview(id);
    if (state.syncSelectedId === id) setState({ syncPreview: preview });
  } catch {
    // A target without a path yet simply has no preview.
  }
}

export function navigate(view, patch = {}) {
  setState({ view, ...patch });
}

export { describeError };
