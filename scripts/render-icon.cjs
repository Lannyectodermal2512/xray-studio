// Rasterise assets/icon.svg with Chromium, via the Electron we already depend on.
//
// Not ImageMagick: without a librsvg delegate its built-in SVG renderer silently drops
// strokes — the first attempt at this icon came out as three dots on a dark square with
// every connecting line missing, and nothing warned about it. Chromium renders the same
// SVG the app itself would, so what ships is what the file says.
//
// Usage: electron scripts/render-icon.cjs <in.svg> <out.png> <size>
const { app, BrowserWindow } = require('electron')
const { readFileSync, writeFileSync } = require('node:fs')

const [svgPath, outPath, sizeArg] = process.argv.slice(2)
const size = Number(sizeArg || 1024)

app.disableHardwareAcceleration()

app.whenReady().then(async () => {
  const svg = readFileSync(svgPath, 'utf8')
  const win = new BrowserWindow({
    width: size,
    height: size,
    show: false,
    frame: false,
    // The corners outside the squircle must stay transparent, or macOS shows the icon
    // sitting on a black tile.
    transparent: true,
    backgroundColor: '#00000000',
    webPreferences: { offscreen: true },
  })

  const html = `<!doctype html><meta charset="utf-8">
    <style>
      html,body{margin:0;padding:0;background:transparent;width:${size}px;height:${size}px;overflow:hidden}
      svg{display:block;width:${size}px;height:${size}px}
    </style>${svg}`
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
  // One frame is not always enough for the compositor to have painted the SVG.
  await new Promise((r) => setTimeout(r, 400))

  const img = await win.webContents.capturePage()
  writeFileSync(outPath, img.toPNG())
  app.exit(0)
})
