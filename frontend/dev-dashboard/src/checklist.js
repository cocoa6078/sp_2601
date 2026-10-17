// 担当別チェック（手動記録・DOM 非依存）
// - 自動検査（逐次 step の照合・API 確認）の結果では更新しない。人が状態を選び、証拠・メモを書く
// - 保存先は localStorage（このブラウザだけの記録。共有・自動送信はしない）。storage は引数で差し替えられる
export const CHECK_STATUSES = ['unchecked', 'checking', 'success', 'failure'];
export const CHECK_STATUS_LABELS = { unchecked: '未確認', checking: '確認中', success: '成功', failure: '失敗' };
export const CHECKLIST_STORAGE_KEY = 'runwave-dev-dashboard:checklist:v1';

const item = (owner, id, title) => ({ id, owner, title, status: 'unchecked', note: '' });

/** 初期項目（指示書 P0-5）。すべて「未確認」から始める */
export function defaultChecklist() {
  return [
    item('安原', 'yasuhara-scenarios', '3 シナリオ（A / B / B-length）の結果がチームの期待と合う'),
    item('安原', 'yasuhara-sequential', '逐次 step の結果が compare / simulate と一致する'),
    item('ふぁん', 'fan-api-get', 'API 取得（GET /api/signals・/api/calibration・/api/logs）'),
    item('ふぁん', 'fan-api-error', 'API 異常応答（停止・非 JSON・空データ・不正値）の扱い'),
    item('蝦名', 'ebina-io', '入出力の合意（CONTRACT / CONTRACT-ext の名前・単位）'),
    item('蝦名', 'ebina-mac-build', 'Mac での Xcode ビルド'),
    item('蝦名', 'ebina-device', '実機（iPhone / Watch）での動作'),
    item('陸斗', 'rikuto-windows', 'Windows での再現（この画面の起動〜ゴール）'),
    item('陸斗', 'rikuto-recording', '比較の収録（撮影・画面録画）'),
    item('陸斗', 'rikuto-video', '動画提出の条件確認'),
  ];
}

export function isValidStatus(s) {
  return CHECK_STATUSES.includes(s);
}

/** 状態を変えた新しい配列を返す（メモなど他の項目には触れない） */
export function setStatus(list, id, status) {
  if (!isValidStatus(status)) throw new RangeError(`未知の状態: ${status}`);
  return list.map((it) => (it.id === id ? { ...it, status } : it));
}

/** メモ（証拠）を変えた新しい配列を返す。状態は変えない（メモを付けても自動で完了にしない） */
export function setNote(list, id, note) {
  return list.map((it) => (it.id === id ? { ...it, note: String(note ?? '') } : it));
}

/** 保存された内容を、初期項目に重ねて読み込む（項目の増減・壊れた JSON に強くする） */
export function mergeSaved(saved) {
  const base = defaultChecklist();
  if (!Array.isArray(saved)) return base;
  return base.map((it) => {
    const s = saved.find((x) => x && x.id === it.id);
    if (!s) return it;
    return { ...it, status: isValidStatus(s.status) ? s.status : 'unchecked', note: typeof s.note === 'string' ? s.note : '' };
  });
}

export function loadChecklist(storage) {
  try {
    const raw = storage?.getItem(CHECKLIST_STORAGE_KEY);
    return mergeSaved(raw ? JSON.parse(raw) : null);
  } catch {
    return defaultChecklist();
  }
}

/** 保存に成功したら true（localStorage が使えない環境では false を返すだけで、画面は動き続ける） */
export function saveChecklist(storage, list) {
  try {
    storage.setItem(CHECKLIST_STORAGE_KEY, JSON.stringify(list.map(({ id, status, note }) => ({ id, status, note }))));
    return true;
  } catch {
    return false;
  }
}

export function checklistCounts(list) {
  const counts = Object.fromEntries(CHECK_STATUSES.map((s) => [s, 0]));
  for (const it of list) counts[it.status] += 1;
  return counts;
}
