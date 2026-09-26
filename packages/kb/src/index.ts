/**
 * @tnotesjs/kb — workspace layer for TNotes single-file knowledge bases.
 *
 * Layout:
 *   tnotes.json   kb config
 *   TOC.md        sole source of structure (groups / order / done)
 *   notes/NNNN. 标题.md
 *   assets/
 */

export * from './types'
export * from './constants'
export * from './errors'
export { parseNoteContent, serializeNoteContent, updateNoteFrontmatter } from './frontmatter'
export {
  parseTocLine,
  buildGroupLine,
  buildNoteLine,
  flattenTocLines,
  parseTocToTree,
  serializeTocTree,
  findNoteLineIndex,
  findGroupLineIndex,
  collectSubtreeNoteIndexes,
  moveSubtree,
  removeSelectedNoteLines,
  setNoteDoneLine,
  setNoteIndexLine,
  setNoteTitleLine,
  normalizeTocBlankLines
} from './toc'
export type { ParsedTocLine, TocLineKind } from './toc'
export { scanKnowledgeBase, readKbConfig, readTocLines, contentRevision } from './scanner'
export { createWorkspace, validateTitle, assertNoteBatchCapacity, NOTE_BATCH_LIMIT, NOTE_COUNT_LIMIT } from './workspace'
export type {
  TNotesKbWorkspace,
  CreateWorkspaceOptions,
  CreateNoteInput,
  CreateNotesInput,
  RenameNoteInput,
  ReindexNoteInput,
  SaveNoteInput,
  SetFrontmatterInput,
  MoveTocEntryInput
} from './workspace'
export { isValidKbName, parseRepoNameFromRemoteUrl, resolveKbName } from './name'
export {
  isKnowledgeBaseRoot,
  createKnowledgeBase,
  STARTER_NOTE_TITLE,
  DOCS_SITE_URL
} from './create'
export type {
  CreateKnowledgeBaseInput,
  CreateKnowledgeBaseOptions,
  CreateKnowledgeBaseResult
} from './create'
export { isGitRepository, initGitRepository, readOriginRemoteUrl } from './git'
export { clearKbIcon, replaceKbIcon, listAssets, addAsset, gcAssets } from './assets'
export {
  applyAssetPlan,
  fillPlanHashes,
  listAssetJournals,
  listIncompleteJournals,
  planMerge,
  planOptimize,
  planRecycle,
  planRename,
  recoverIncompleteJournals,
  restoreAssetPlan,
  runSerializedAssetWork,
  scanAssets,
  findReusableAsset,
  hashAssetFiles,
  hashBytes,
  ownerNoteIndexFromName
} from './asset-scan'
export type {
  ApplyAssetPlanOptions,
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
  AssetStorePaths,
  AssetSyntaxKind,
  AssetUrlKind,
  ScanAssetsOptions
} from './asset-scan'
export {
  parseCompletedNoteIndexes,
  computeCompletedNotesCount,
  updateCompletedNotesStats,
  fillCompletedNotesCount,
  toMonthKey
} from './stats'
export {
  KB_TEXT_MAX_BYTES,
  classifyKbPath,
  isLikelyTextPath,
  languageForKbPath,
  listKbDirectory,
  looksLikeText,
  readKbTextFile
} from './files'
export type { KbDirectoryEntry, KbPathPolicy, KbTextFile } from './files'
export { applyAtomicWrites, writeFileAtomic } from './atomic'
export type { AtomicWrite } from './atomic'
export {
  EXCALIDRAW_DERIVED_EXTENSION,
  EXCALIDRAW_EXTENSION,
  copyExcalidrawDocument,
  createExcalidrawDocument,
  derivedSvgRelPath,
  emptyExcalidrawScene,
  findExcalidrawSourceFor,
  readExcalidrawDocument,
  sourceRelPathForDerived,
  writeExcalidrawDerivedSvg,
  writeExcalidrawDocument
} from './excalidraw'
export type {
  CopyExcalidrawDocumentInput,
  CreateExcalidrawDocumentInput,
  ExcalidrawDerivedSvgRef,
  ExcalidrawDocument,
  ExcalidrawDocumentRef,
  ExcalidrawSourceRef,
  WriteExcalidrawDerivedSvgInput,
  WriteExcalidrawDocumentInput
} from './excalidraw'
