import { afterEach, expect, it, vi } from 'vitest'
import { runFinalizationGeneration } from '../finalization-generation'
const session = { projectId: '项目', leaseId: '会话', projectPath: 'C:/合成定稿' }
const source = { finalizationId: '定稿', draftId: 1, chapterNumber: 1, contentHash: 'a'.repeat(64) }
const slot = { source, stepKey: 'chapter_notes' as const }
const handle = { projectId: '项目', epoch: '原会话', rootActionId: '原根', runId: '原运行' }
const candidate = { ...handle, artifactId: '原候选', revision: 3, textHash: 'b'.repeat(64), text: '原要点', status: 'completed', compositionEligible: true }
const view = { handle, artifacts: [candidate], status: 'completed', ledger: { physicalRequests: 1 } }
const stored = { view, attemptCount: 1, modelId: '原模型', context: { slot }, sourceStatus: 'current' }
const effect = { success: true, stepKey: 'chapter_notes', chapterNotes: '原要点', factCount: 1, blueprintUpdated: true }
afterEach(() => vi.unstubAllGlobals())
function setup(invoke: ReturnType<typeof vi.fn>) { vi.stubGlobal('window', { aiNovelAPI: { invoke, on: () => () => {} } }); return { session, slot, modelId: vi.fn(() => '新模型'), cancelled: () => false } }
it('已 ACK effect 只读回放，不解析模型或重做正式写入', async () => {
 const invoke = vi.fn(async () => ({ ...stored, sourceStatus: 'conflict', effect }))
 const options = setup(invoke)
 await expect(runFinalizationGeneration(options)).resolves.toEqual(effect)
 expect(options.modelId).not.toHaveBeenCalled()
 expect(invoke.mock.calls).toHaveLength(1)
})
it('原完整候选仅提交原 artifact，不重建 task/model/预算', async () => {
 const invoke = vi.fn(async (channel: string, request: unknown) => {
  if (channel === 'finalization-generation:read' || channel === 'finalization-generation:begin') return stored
  expect(channel).toBe('finalization-generation:commit')
  expect(request).toEqual({ handle, artifact: { artifactId: candidate.artifactId, revision: 3, textHash: candidate.textHash } })
  return effect
 })
 const options = setup(invoke)
 await expect(runFinalizationGeneration(options)).resolves.toEqual(effect)
 expect(options.modelId).not.toHaveBeenCalled()
})
it.each(['unknown', 'failed'])('%s 原角色候选不可重发或提交', async status => {
 const characterSlot = { ...slot, stepKey: 'character_cards' as const }
 const invoke = vi.fn(async () => ({ ...stored, context: { slot: characterSlot }, view: { ...view, artifacts: [{ ...candidate, status, compositionEligible: false }] } }))
 await expect(runFinalizationGeneration({ ...setup(invoke), slot: characterSlot })).rejects.toThrow('FINALIZATION_GENERATION_ARTIFACT_REQUIRED')
 expect(invoke).toHaveBeenCalledTimes(2)
})
it('旧角色坏 JSON stop 候选交由 main 有界修复，仅提交最后有效候选', async () => {
 const characterSlot = { ...slot, stepKey: 'character_cards' as const }
 const repaired = { ...candidate, artifactId: '修复候选', text: '{"updates":[]}', textHash: 'c'.repeat(64) }
 const characterEffect = { success: true, stepKey: 'character_cards' }
 const invoke = vi.fn(async (channel: string, request: unknown) => {
  if (channel === 'finalization-generation:read' || channel === 'finalization-generation:begin') return { ...stored, context: { slot: characterSlot }, view: { ...view, artifacts: [{ ...candidate, text: '{bad' }] } }
  if (channel === 'finalization-generation:execute') return { run: { ...view, artifacts: [candidate, repaired] }, outcome: { status: 'completed', finishReason: 'stop', receipt: { visibleArtifact: { artifactId: repaired.artifactId, revision: repaired.revision, textHash: repaired.textHash } } } }
  expect(channel).toBe('finalization-generation:commit')
  expect(request).toEqual({ handle, artifact: { artifactId: repaired.artifactId, revision: repaired.revision, textHash: repaired.textHash } })
  return characterEffect
 })
 const options = { ...setup(invoke), slot: characterSlot }
 await expect(runFinalizationGeneration(options)).resolves.toEqual(characterEffect)
 expect(options.modelId).not.toHaveBeenCalled()
 expect(invoke.mock.calls.map(([channel]) => channel)).toEqual(['finalization-generation:read', 'finalization-generation:begin', 'finalization-generation:execute', 'finalization-generation:commit'])
})
it.each([false, true])('重新准入缺失或取消的 slot 后执行，历史取消=%s', async cancelled => {
 const invoke = vi.fn(async (channel: string, request: unknown) => {
  if (channel === 'finalization-generation:read') return cancelled ? { ...stored, view: { ...view, status: 'cancelled' } } : null
  if (channel === 'finalization-generation:begin') { expect(request).toEqual({ slot, modelId: cancelled ? '原模型' : '新模型' }); return { ...stored, attemptCount: 0, view: { ...view, artifacts: [], ledger: { physicalRequests: 9 } } } }
  if (channel === 'finalization-generation:execute') { expect(request).toEqual({ handle }); return { run: view, outcome: { status: 'completed', finishReason: 'stop', receipt: { visibleArtifact: { artifactId: candidate.artifactId, revision: candidate.revision, textHash: candidate.textHash } } } } }
  if (channel === 'finalization-generation:commit') return effect
  throw new Error(channel)
 })
 await expect(runFinalizationGeneration(setup(invoke))).resolves.toEqual(effect)
 expect(invoke.mock.calls.map(([channel]) => channel)).toEqual(['finalization-generation:read', 'finalization-generation:begin', 'finalization-generation:execute', 'finalization-generation:commit'])
})
it('取消晚到 begin 会取消原 main run，不执行', async () => {
 let cancelled = false
 const invoke = vi.fn(async (channel: string) => {
  if (channel === 'finalization-generation:read') return null
  if (channel === 'finalization-generation:begin') { cancelled = true; return stored }
  if (channel === 'finalization-generation:cancel') return view
  throw new Error(channel)
 })
 await expect(runFinalizationGeneration({ ...setup(invoke), cancelled: () => cancelled })).rejects.toThrow('GENERATION_WORKFLOW_CANCELLED')
 expect(invoke.mock.calls.map(([channel]) => channel)).toEqual(['finalization-generation:read', 'finalization-generation:begin', 'finalization-generation:cancel'])
})
it('提交失败后同 slot 重试仅提交原候选，不消耗新请求', async () => {
 let commits = 0
 const invoke = vi.fn(async (channel: string) => {
  if (channel === 'finalization-generation:read' || channel === 'finalization-generation:begin') return stored
  if (channel === 'finalization-generation:commit') { if (++commits === 1) throw new Error('synthetic-write-failure'); return effect }
  throw new Error(channel)
 })
 const options = setup(invoke)
 await expect(runFinalizationGeneration(options)).rejects.toThrow('synthetic-write-failure')
 await expect(runFinalizationGeneration(options)).resolves.toEqual(effect)
 expect(options.modelId).not.toHaveBeenCalled()
 expect(invoke.mock.calls.map(([channel]) => channel)).toEqual(['finalization-generation:read', 'finalization-generation:begin', 'finalization-generation:commit', 'finalization-generation:read', 'finalization-generation:begin', 'finalization-generation:commit'])
})
it('即使有 ACK 也拒绝串用别的 finalization source', async () => {
 const invoke = vi.fn(async () => ({ ...stored, context: { slot: { ...slot, source: { ...source, finalizationId: '别的定稿' } } }, effect }))
 await expect(runFinalizationGeneration(setup(invoke))).rejects.toThrow('FINALIZATION_GENERATION_IDENTITY_MISMATCH')
 expect(invoke).toHaveBeenCalledTimes(1)
})

it.each(['completed', 'running'])('显式重试按 receipt 的历史 artifact 提交，当前候选 %s 时仍回放原请求', async status => {
 const characterSlot = { ...slot, stepKey: 'character_cards' as const }
 const retryOf = { artifactId: candidate.artifactId, revision: candidate.revision, textHash: candidate.textHash }
 const historical = { ...candidate, artifactId: '本次修复候选', textHash: 'c'.repeat(64) }
 const latest = { ...candidate, artifactId: '后续修复候选', textHash: 'd'.repeat(64), status }
 const invoke = vi.fn(async (channel: string, request: unknown) => {
  if (channel === 'finalization-generation:read' || channel === 'finalization-generation:begin') return { ...stored, context: { slot: characterSlot }, view: { ...view, artifacts: [candidate, historical, latest] } }
  if (channel === 'finalization-generation:execute') {
   expect(request).toEqual({ handle, retryOf })
   return { run: { ...view, artifacts: [candidate, historical, latest] }, outcome: { status: 'completed', finishReason: 'stop', receipt: { visibleArtifact: { artifactId: historical.artifactId, revision: historical.revision, textHash: historical.textHash } } } }
  }
  expect(request).toEqual({ handle, artifact: { artifactId: historical.artifactId, revision: historical.revision, textHash: historical.textHash } })
  return { success: true, stepKey: 'character_cards' }
 })
 await runFinalizationGeneration({ ...setup(invoke), slot: characterSlot, retryOf })
})
it('已发请求且模型正常结束但结果不可用：报结果不可用，不说没有发出请求', async () => {
 const empty = { ...candidate, artifactId: '空候选', text: '', compositionEligible: false }
 const invoke = vi.fn(async (channel: string) => {
  if (channel === 'finalization-generation:read') return null
  if (channel === 'finalization-generation:begin') return { ...stored, attemptCount: 0, view: { ...view, artifacts: [] } }
  if (channel === 'finalization-generation:execute') return { run: { ...view, artifacts: [empty] }, outcome: { status: 'completed', finishReason: 'stop', receipt: { visibleArtifact: { artifactId: empty.artifactId, revision: empty.revision, textHash: empty.textHash } } } }
  throw new Error(channel)
 })
 await expect(runFinalizationGeneration(setup(invoke))).rejects.toThrow('FINALIZATION_GENERATION_RESULT_UNUSABLE')
 expect(invoke.mock.calls.map(([channel]) => channel)).toEqual(['finalization-generation:read', 'finalization-generation:begin', 'finalization-generation:execute'])
})
it('回放已有的正常结束但不可用的候选：同样报结果不可用，不重发', async () => {
 const invoke = vi.fn(async (channel: string) => {
  if (channel === 'finalization-generation:read' || channel === 'finalization-generation:begin') return { ...stored, view: { ...view, artifacts: [{ ...candidate, text: '', compositionEligible: false }] } }
  throw new Error(channel)
 })
 await expect(runFinalizationGeneration(setup(invoke))).rejects.toThrow('FINALIZATION_GENERATION_RESULT_UNUSABLE')
 expect(invoke.mock.calls.map(([channel]) => channel)).toEqual(['finalization-generation:read', 'finalization-generation:begin'])
})

// 复现先收到 503、随后内部重试只读历史的流程；只有显式恢复才能再发一次请求。
it.each(['chapter_notes', 'character_cards'] as const)('%s 的 HTTP 503 原因跨回放保留，显式恢复成功后只提交新候选', async stepKey => {
 const selectedSlot = { ...slot, stepKey }
 const failed = { ...candidate, attemptId: '失败尝试', status: 'unknown', compositionEligible: false,
  diagnostics: { httpStatus: 503 } }
 const fixed = { ...candidate, attemptId: '恢复尝试', artifactId: '恢复候选' }
 let executed = 0
 const invoke = vi.fn(async (channel: string, request: { recoverFrom?: string }) => {
  if (channel === 'finalization-generation:read' || channel === 'finalization-generation:begin') {
   return { ...stored, context: { slot: selectedSlot }, attemptCount: executed ? 1 : 0,
    view: { ...view, artifacts: executed ? [failed] : [] },
    ...(executed ? { latestAttempt: { attemptId: failed.attemptId, inFlight: false, finishReason: null, failureCode: 'GENERATION_PROVIDER_FAILED' } } : {}) }
  }
  if (channel === 'finalization-generation:execute') {
   executed++
   if (executed === 1) return { run: { ...view, artifacts: [failed] }, outcome: { status: 'incomplete', finishReason: 'error',
    receipt: { failureCode: 'GENERATION_PROVIDER_FAILED', diagnostics: { httpStatus: 503 } } } }
   expect(request.recoverFrom).toBe(failed.attemptId)
   return { run: { ...view, artifacts: [failed, fixed] }, outcome: { status: 'completed', finishReason: 'stop',
    receipt: { visibleArtifact: { artifactId: fixed.artifactId, revision: fixed.revision, textHash: fixed.textHash } } } }
  }
  expect(channel).toBe('finalization-generation:commit')
  expect(request).toEqual({ handle, artifact: { artifactId: fixed.artifactId, revision: fixed.revision, textHash: fixed.textHash } })
  return { ...effect, stepKey }
 })
 const options = { ...setup(invoke), slot: selectedSlot }
 await expect(runFinalizationGeneration(options)).rejects.toThrow('FINALIZATION_GENERATION_SERVICE_UNAVAILABLE')
 await expect(runFinalizationGeneration(options)).rejects.toThrow('FINALIZATION_GENERATION_SERVICE_UNAVAILABLE')
 expect(executed).toBe(1)
 await expect(runFinalizationGeneration({ ...options, recoverFrom: failed.attemptId })).resolves.toMatchObject({ success: true })
 expect(executed).toBe(2)
})
it('回放时不把同根另一步骤的 503 误当成本步骤的诊断', async () => {
 const invoke = vi.fn(async () => ({ ...stored,
  latestAttempt: { attemptId: '当前尝试', inFlight: false, finishReason: null, failureCode: 'NETWORK_ERROR' },
  view: { ...view, artifacts: [{ ...candidate, attemptId: '其他步骤', status: 'unknown', compositionEligible: false, diagnostics: { httpStatus: 503 } }] } }))
 await expect(runFinalizationGeneration(setup(invoke))).rejects.toThrow('FINALIZATION_GENERATION_INCOMPLETE')
 expect(invoke).toHaveBeenCalledTimes(2)
})
