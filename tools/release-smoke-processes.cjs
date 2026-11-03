/* CI-only Windows smoke cleanup helpers. No process arguments or environment are collected. */
const { spawn } = require('node:child_process')
const path = require('node:path')

function normalizeProcesses(value) {
  const rows = Array.isArray(value) ? value : value && typeof value === 'object' ? [value] : null
  if (!rows || !rows.length) throw new Error('process-enumeration-invalid')
  const seen = new Set()
  return rows.map(row => {
    if (!row || !Number.isSafeInteger(row.pid) || row.pid < 0 || !Number.isSafeInteger(row.parent) || row.parent < 0 || seen.has(row.pid)) throw new Error('process-enumeration-invalid')
    seen.add(row.pid)
    return { pid: row.pid, parent: row.parent, birth: typeof row.birth === 'string' && /^\d+$/.test(row.birth) ? row.birth : null, image: typeof row.image === 'string' ? row.image : null }
  })
}
const imageEquals = (a, b) => typeof a === 'string' && path.win32.normalize(a).toLowerCase() === path.win32.normalize(b).toLowerCase()
function captureProcessTree(rows, rootPid, executable) {
  const root = rows.find(row => row.pid === rootPid)
  if (!root || !root.birth || !imageEquals(root.image, executable)) throw new Error('process-tree-root-unverified')
  const ids = new Set([rootPid])
  let changed = true
  while (changed) {
    changed = false
    for (const row of rows) if (!ids.has(row.pid) && ids.has(row.parent)) { ids.add(row.pid); changed = true }
  }
  const tracked = rows.filter(row => ids.has(row.pid) || imageEquals(row.image, executable))
  if (tracked.some(row => !row.birth)) throw new Error('process-tree-identity-unavailable')
  return tracked.map(row => ({ pid: row.pid, birth: row.birth }))
}
function processesGone(tracked, rows, executable) {
  const identities = new Set(tracked.map(row => `${row.pid}:${row.birth}`))
  return !rows.some(row => imageEquals(row.image, executable) || (row.birth && identities.has(`${row.pid}:${row.birth}`)) || (!row.birth && tracked.some(item => item.pid === row.pid)))
}

/** Bounded CIM enumeration; never log stdout, executable paths, or command lines. */
function enumerateWindowsProcesses(timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const systemRoot = process.env.SystemRoot || process.env.SYSTEMROOT
    const executable = systemRoot ? path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : 'powershell.exe'
    const script = "$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new(); $p=@(Get-CimInstance Win32_Process | ForEach-Object { @{ pid=[int]$_.ProcessId; parent=[int]$_.ParentProcessId; birth=$(if ($_.CreationDate) { $_.CreationDate.ToFileTimeUtc().ToString() } else { $null }); image=$_.ExecutablePath } }); ConvertTo-Json -InputObject $p -Compress -Depth 3"
    let child, output = '', settled = false
    const finish = (error, value) => {
      if (settled) return
      settled = true; clearTimeout(timer)
      if (error) reject(new Error('process-enumeration-failed'))
      else { try { resolve(normalizeProcesses(JSON.parse(value))) } catch { reject(new Error('process-enumeration-invalid')) } }
    }
    const timer = setTimeout(() => { try { child?.kill('SIGKILL') } catch { /* bounded */ }; child?.stdout?.destroy(); child?.stderr?.destroy(); child?.unref(); finish(true) }, timeoutMs)
    try {
      child = spawn(executable, ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
      child.stdout.on('data', chunk => { output += chunk.toString('utf8'); if (output.length > 4_000_000) { try { child.kill('SIGKILL') } catch { /* bounded */ }; finish(true) } })
      child.once('error', () => finish(true))
      child.once('close', code => finish(code !== 0, output))
    } catch { finish(true) }
  })
}
module.exports = { normalizeProcesses, captureProcessTree, processesGone, enumerateWindowsProcesses }
