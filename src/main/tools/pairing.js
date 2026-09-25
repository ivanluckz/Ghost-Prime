import QRCode from 'qrcode'
import { getBridgeInfo } from './browser-bridge.js'

// Phone pairing: a QR code carrying everything the Android connector needs (bridge host, port,
// token). The phone's camera opens the ghostprime:// link straight into the connector app, which
// saves it and connects — nothing to type.
//
// Host: the Chromebook's own Wi-Fi IP (Settings → Network → Wi-Fi → IP address). It can't be read
// from inside Crostini (the container only sees its internal 100.115.x address), so it comes from
// the caller (the Settings field / the agent) or GHOST_PHONE_HOST in .env.
export async function pairingInfo({ host } = {}) {
  const info = getBridgeInfo() || {}
  const port = Number(info.port || process.env.GHOST_BRIDGE_PORT || 8731)
  const token = (process.env.GHOST_BRIDGE_TOKEN || 'ghost-local').trim()
  const h = String(host || process.env.GHOST_PHONE_HOST || '').trim()
  const problems = []
  if (!h) problems.push("Enter the Chromebook's Wi-Fi IP (Settings → Network → Wi-Fi → IP address).")
  if (info.host && info.host !== '0.0.0.0')
    problems.push(`The bridge only listens on ${info.host}, so the phone can't reach it — set GHOST_BRIDGE_HOST=0.0.0.0 and a private GHOST_BRIDGE_TOKEN in .env, then restart Ghost-Prime.`)
  const uri = h
    ? `ghostprime://pair?host=${encodeURIComponent(h)}&port=${port}&token=${encodeURIComponent(token)}`
    : ''
  const dataUrl = uri ? await QRCode.toDataURL(uri, { margin: 1, width: 360, errorCorrectionLevel: 'M' }) : ''
  return { host: h, port, uri, dataUrl, problems }
}
