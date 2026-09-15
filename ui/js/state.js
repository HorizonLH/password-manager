import { api } from "./api.js";
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
  locked: true,
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
  scanOptions: null,
  scanReport: null,
  scanPicked: new Set(),
  scanRunning: false,
  scanProgress: { scanned: 0, path: "" },
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
    locked: true,
    settings: info.settings,
    presets: info.presets,
    paths: {
      dataDir: info.dataDir,
      vaultPath: info.vaultPath,
      landscapeDefaults: info.landscapeDefaults,
      landscapePaths: info.landscapePaths,
      scanRootDefault: info.scanRootDefault,
    },
    scanOptions: buildScanDefaults(info.settings, info.scanRootDefault),
  });
}

export function buildScanDefaults(settings, scanRootDefault) {
  const roots =
    settings?.scanRoots && settings.scanRoots.length
      ? [...settings.scanRoots]
      : [scanRootDefault ?? "C:\\"];
  return {
    roots,
    hosts: [],
    systemIds: [],
    usernames: [],
    strict: settings?.scanStrict ?? true,
    maxFileBytes: settings?.scanMaxFileBytes ?? 2097152,
    maxFiles: settings?.scanMaxFiles ?? 30000,
    maxDepth: settings?.scanMaxDepth ?? 10,
    followLinks: false,
    onlyExtensions: settings?.scanOnlyExtensions ?? [],
    extraSkipPaths: settings?.scanExtraSkips ?? [],
    label: "",
    targetEntryId: "",
  };
}

export async function createVault(mode, password, hint) {
  await api.vaultCreate(mode, password || null, hint || "");
  setState({ hasVault: true, mode, hint: hint || "", locked: false, startupError: null });
  await refreshVault();
  toast("保险库已创建，可以开始添加账号", "success");
}

export async function unlock(password) {
  const view = await api.vaultUnlock(password || null);
  setState({ locked: false, vault: view });
  toast("保险库已解锁", "success");
}

export async function lock() {
  if (state.locked) return;
  await api.vaultLock();
  applyLockedState();
}

export function handleLocked() {
  if (state.locked) return;
  applyLockedState();
  toast("已自动锁定", "info");
}

function applyLockedState() {
  setState({
    locked: true,
    vault: null,
    selectedEntry: null,
    selectedEntryId: null,
    scanReport: null,
    scanPicked: new Set(),
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

export async function reloadSelected() {
  if (!state.selectedEntryId) return;
  const entry = await api.entryGet(state.selectedEntryId);
  setState({ selectedEntry: entry });
}

export async function setKnoxId(value) {
  const vault = await api.knoxSet(value);
  setState({ vault });
}

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

export async function addLinks(entryId, paths) {
  const entry = await api.linkAdd(entryId, paths);
  await refreshVault();
  if (state.selectedEntryId === entryId) setState({ selectedEntry: entry });
  toast(`已关联 ${paths.length} 个文件`, "success");
  return entry;
}

export async function removeLink(entryId, linkId) {
  const entry = await api.linkRemove(entryId, linkId);
  await refreshVault();
  if (state.selectedEntryId === entryId) setState({ selectedEntry: entry });
  return entry;
}

// -------------------------------------------------------------------- scan --

export async function runScan() {
  setState({
    scanRunning: true,
    scanReport: null,
    scanPicked: new Set(),
    scanProgress: { scanned: 0, path: "" },
  });
  try {
    const report = await api.scanRun(state.scanOptions);
    setState({
      scanReport: report,
      scanRunning: false,
      scanPicked: new Set(report.hits.map((hit) => hit.path)),
    });
    return report;
  } catch (error) {
    setState({ scanRunning: false });
    throw error;
  }
}

export async function cancelScan() {
  await api.scanCancel();
  toast("正在停止扫描…", "info");
}

export async function attachScan(entryId, hits, replace) {
  const entry = await api.scanAttach(entryId, hits, replace);
  await refreshVault();
  if (state.selectedEntryId === entryId) setState({ selectedEntry: entry });
  toast(`已关联 ${hits.length} 个扫描结果`, "success");
}

export function handleScanProgress(payload) {
  setState({ scanProgress: payload });
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
