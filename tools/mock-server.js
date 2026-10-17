// api-check.js 自体を試すための偽サーバー（バックエンド・API連携ガイド 10/17版の形に合わせる。
// ガイドに無い部分＝エラー時の形・GET /api/calibration と GET /api/logs の応答形は想定。sapporo_3 以外の信号値は架空）
// 単体起動: node tools/mock-server.js [port]   → node tools/api-check.js http://localhost:<port> --write
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';

// broken: true にすると、計画の B1〜B3 が未対応のときの振る舞い（500・HTML・合計不一致）を返す
export function createMockServer({ broken = false } = {}) {
  const logs = [];
  let calibration = { '歩幅': 0.8, '通常BPM': 150 };
  const ok = (data) => ({ 'ステータス': '成功', 'データ': data });
  const fail = (msg) => ({ 'ステータス': '失敗', 'エラー': msg });
  const send = (res, status, body) => {
    if (broken && status >= 400) {
      res.writeHead(500, { 'content-type': 'text/html' });
      return res.end('<h1>Internal Server Error</h1>');
    }
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' });
    res.end(JSON.stringify(body));
  };
  const readBody = (req) => new Promise((resolve) => {
    let s = '';
    req.on('data', (d) => { s += d; });
    req.on('end', () => resolve(s));
  });
  const positive = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0;

  return createServer(async (req, res) => {
    const raw = await readBody(req);
    let body = {};
    if (raw) {
      try { body = JSON.parse(raw); } catch { return send(res, 400, fail('JSON が読めません')); }
    }
    const route = `${req.method} ${req.url}`;
    if (route === 'GET /api/signals') {
      const note = '※JARTIC由来の参考プリセット（車両用データ流用）';
      return send(res, 200, ok([
        { signalId: 'sapporo_3', cycleS: 125, greenS: 39, yellowS: 5, redS: 81, phaseS: 0, crossingM: 15.0, note },
        { signalId: 'mock_demo', cycleS: 120, greenS: 50, yellowS: 5, redS: broken ? 60 : 65, phaseS: 90, crossingM: 20, note: '架空（偽サーバー）' },
      ]));
    }
    if (route === 'GET /api/calibration') return send(res, 200, ok(calibration));
    if (route === 'POST /api/calibration') {
      if (!raw) return send(res, 400, fail('body がありません'));
      if (!positive(body['歩幅']) || !positive(body['通常BPM'])) return send(res, 400, fail('歩幅と通常BPMは正の数値'));
      calibration = { '歩幅': body['歩幅'], '通常BPM': body['通常BPM'] };
      return send(res, 200, ok(calibration));
    }
    if (route === 'GET /api/logs') return send(res, 200, ok(logs));
    if (route === 'POST /api/logs') {
      if (!raw) return send(res, 400, fail('body がありません'));
      logs.push(body);
      return send(res, 201, ok({ count: logs.length }));
    }
    return send(res, 404, fail('not found'));
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const port = Number(process.argv[2] || 8787);
  createMockServer().listen(port, () => console.log(`mock API: http://localhost:${port}`));
}
