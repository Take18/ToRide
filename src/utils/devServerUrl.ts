// 開発サーバーの「ポート番号 or URL」入力値をブラウザで開けるURLに解決する
// - 数字のみ（例: "3000"） → http://localhost:3000
// - スキーム付きURL（例: "https://localhost.example.test:3000"） → そのまま
// - スキームなしホスト（例: "localhost.example.test:3000"） → http:// を付与
export function resolveDevServerUrl(input?: string): string | undefined {
  const trimmed = input?.trim()
  if (!trimmed) return undefined
  if (/^\d+$/.test(trimmed)) return `http://localhost:${trimmed}`
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)) return trimmed
  return `http://${trimmed}`
}
