import { describe, expect, it } from 'vitest'
import {
  KIMI_CU_MCP_SERVER_ID,
  buildKimiCuMcpServer,
  inspectKimiCuMcpConfig,
  parseKimiCuPermissions,
  parseKimiCuServiceStatus
} from '../kimiComputerUse'

const binary = '/Applications/KimiCU.app/Contents/MacOS/kimi-cu'

describe('Kimi Computer Use bridge contract', () => {
  it('parses the official XPC permission probe without accepting malformed output', () => {
    expect(
      parseKimiCuPermissions('permissionStatus: accessibility=true screenRecording=false')
    ).toEqual({ accessibilityGranted: true, screenRecordingGranted: false })
    expect(parseKimiCuPermissions('accessibility=true')).toBeNull()
  })

  it('parses the official service status probe', () => {
    expect(parseKimiCuServiceStatus('SMAppService status=1 (1=enabled)')).toBe(true)
    expect(parseKimiCuServiceStatus('SMAppService status=2 (requires approval)')).toBe(false)
    expect(parseKimiCuServiceStatus('no status here')).toBeNull()
  })

  it('recognizes only the exact managed stdio registration', () => {
    const managed = buildKimiCuMcpServer(binary)
    expect(
      inspectKimiCuMcpConfig(JSON.stringify({ mcpServers: { [KIMI_CU_MCP_SERVER_ID]: managed } }), binary)
    ).toEqual({ configured: true })

    expect(
      inspectKimiCuMcpConfig(
        JSON.stringify({
          mcpServers: { [KIMI_CU_MCP_SERVER_ID]: { ...managed, args: ['not-mcp'] } }
        }),
        binary
      )
    ).toEqual({
      configured: false,
      error: 'The Kimi CU bridge entry was changed outside OMP GUI; it was left untouched.'
    })
  })

  it('refuses to interpret malformed foreign MCP configuration as empty', () => {
    expect(inspectKimiCuMcpConfig('{', binary)).toEqual({
      configured: false,
      error: 'OMP MCP configuration is not valid JSON.'
    })
    expect(inspectKimiCuMcpConfig(JSON.stringify({ mcpServers: [] }), binary)).toEqual({
      configured: false,
      error: 'OMP MCP configuration has an invalid mcpServers field.'
    })
  })
})
