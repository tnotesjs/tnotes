export type {
  AssetBackupSpec,
  AssetBrokenLink,
  AssetCoverageAdapter,
  AssetDiagnostic,
  AssetDiagnosticCode,
  AssetDuplicateGroup,
  AssetFileKind,
  AssetFileMove,
  AssetJournalRecord,
  AssetJournalStage,
  AssetOperationPlan,
  AssetOperationResult,
  AssetRecord,
  AssetRecordStatus,
  AssetReference,
  AssetScanReport,
  AssetScanSource,
  AssetSourcePatch,
  AssetSyntaxKind,
  AssetUrlKind,
  ScanAssetsOptions
} from './types'
export {
  classifyAssetUrl,
  offsetToLineColumn,
  rewriteLocalAssetUrl,
  resolveLocalKbPath
} from './paths'
export { extractAssetReferences } from './extract'
export { scanAssets } from './scan'
export { planMerge, planOptimize, planRecycle, planRename } from './plan'
export type { OptimizePlanItem } from './plan'
export {
  applyAssetPlan,
  applyPatchesToText,
  fillPlanHashes,
  listAssetJournals,
  listIncompleteJournals,
  recoverIncompleteJournals,
  restoreAssetPlan,
  runSerializedAssetWork
} from './apply'
export type { ApplyAssetPlanOptions, AssetStorePaths } from './apply'
export {
  duplicateGroupsFromHashes,
  findReusableAsset,
  hashAssetFiles,
  hashBytes,
  withAssetHashes
} from './dedupe'
export {
  assetOwnerFromName,
  README_ASSET_OWNER,
  ownerNoteIndexFromName,
  compatibleAssetTypes,
  isContentReusableAsset
} from './owner'
