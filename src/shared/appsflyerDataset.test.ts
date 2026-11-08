import { describe, expect, it } from 'vitest'
import { parseAppsFlyerDatasetRefreshRequest, validateAppsFlyerDatasetState } from './appsflyerDataset'
import { validateDataset } from './datasets'

describe('AppsFlyer board refresh contract', () => {
  it('requires a bounded explicit dataset scope and actual calendar dates', () => {
    expect(parseAppsFlyerDatasetRefreshRequest({ start: '2026-11-01', end: '2026-11-05' })).toBeNull()
    expect(parseAppsFlyerDatasetRefreshRequest({ start: '2026-11-01', end: '2026-11-05', datasetIds: [] })).toBeNull()
    expect(parseAppsFlyerDatasetRefreshRequest({ start: '2026-02-30', end: '2026-03-01', datasetIds: ['AF-Test'] })).toBeNull()
    expect(parseAppsFlyerDatasetRefreshRequest({ start: '2026-11-05', end: '2026-11-01', datasetIds: ['AF-Test'] })).toBeNull()
    expect(parseAppsFlyerDatasetRefreshRequest({ start: '2026-11-01', end: '2026-11-05', datasetIds: ['AF-Test', 'AF-Test'] })).toEqual({ start: '2026-11-01', end: '2026-11-05', datasetIds: ['AF-Test'] })
  })

  it('retains status and the previous data window through the dataset read validator', () => {
    const state = {
      specId: 'synthetic-spec', status: 'failed', window: { start: '2026-11-05', end: '2026-11-05' },
      dataWindow: { start: '2026-11-04', end: '2026-11-04' }, attemptedAt: 100, error: 'synthetic failure'
    }
    expect(validateAppsFlyerDatasetState(state)).toEqual(state)
    expect(validateDataset({ id: 'synthetic-dataset', name: 'AF-Test', columns: [{ name: '安装', type: 'number' }], rows: [[4]], createdAt: 1, appsflyer: state })?.appsflyer).toEqual(state)
    expect(validateAppsFlyerDatasetState({ ...state, dataWindow: { start: 'bad', end: 'bad' } })).toBeNull()
    expect(validateAppsFlyerDatasetState({ ...state, status: 'updated' })).toBeNull()
    expect(validateAppsFlyerDatasetState({ ...state, status: 'empty', dataWindow: undefined })).toBeNull()
    expect(validateAppsFlyerDatasetState({ ...state, status: 'updated', dataWindow: state.window })).toMatchObject({ status: 'updated' })
    expect(validateAppsFlyerDatasetState({ ...state, status: 'updated', dataWindow: state.window, partial: true })).toMatchObject({ status: 'updated', partial: true })
    expect(validateAppsFlyerDatasetState({ ...state, partial: 'yes' })).toBeNull()
  })
})
