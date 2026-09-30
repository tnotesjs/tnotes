<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import { pushToast } from '../../stores/toast'
import { useWorkspaceStore } from '../../stores/workspace'
import ImageOptimizePlayground from './ImageOptimizePlayground.vue'
import ResetGroupButton from './ResetGroupButton.vue'

import type { AppSettings, DeskResult, ImageTokenStatus } from '../../../../shared/contracts'

defineProps<{ draft: AppSettings }>()
const emit = defineEmits<{ reset: [] }>()
const store = useWorkspaceStore()

const token = ref('')
const clearToken = ref(false)
const tokenStatus = ref<ImageTokenStatus>({ configured: false, encryptionAvailable: false })
const busy = ref(false)

const tokenHint = computed(() => {
  if (!tokenStatus.value.encryptionAvailable) return '当前系统暂不可用安全加密存储'
  if (clearToken.value) return '保存后会移除已经保存的 Token'
  if (tokenStatus.value.configured) return '已安全保存；留空不会修改现有 Token'
  return '仅保存在系统加密后的 Desk 私有配置中'
})

function resultValue<T>(result: DeskResult<T>): T {
  if (result.ok) return result.value
  throw new Error(result.error.message)
}

async function refreshTokenStatus(): Promise<void> {
  tokenStatus.value = resultValue<ImageTokenStatus>(await window.desk.settings.imageTokenStatus())
}

async function validateGitHub(draft: AppSettings): Promise<void> {
  if (busy.value) return
  busy.value = true
  try {
    const result = await window.desk.settings.validateImageSettings({
      github: { ...draft.imageUpload.github },
      token: token.value.trim() || undefined
    })
    if (!result.ok) throw new Error(result.error.message)
    pushToast(
      `${result.value.repository} · ${result.value.branch}：${result.value.message}`,
      'success'
    )
  } catch (cause) {
    pushToast(cause instanceof Error ? cause.message : String(cause), 'error')
  } finally {
    busy.value = false
  }
}

async function applyToken(): Promise<void> {
  try {
    const result = await window.desk.settings.updateImageToken({
      token: token.value.trim() || undefined,
      clear: clearToken.value
    })
    tokenStatus.value = resultValue<ImageTokenStatus>(result)
  } catch (cause) {
    store.error = cause instanceof Error ? cause.message : String(cause)
  }
}

onMounted(() => {
  void refreshTokenStatus().catch((cause) => {
    pushToast(cause instanceof Error ? cause.message : String(cause), 'error')
  })
})
</script>

<template>
  <section class="settings-section image-settings">
    <header class="section-heading">
      <strong>图片处理与 GitHub 图床</strong>
      <span>图床上传失败时始终自动回退到当前笔记的 assets 目录</span>
    </header>
    <ResetGroupButton @reset="emit('reset')" />

    <div class="target-choice">
      <label :class="{ selected: draft.imageUpload.defaultTarget === 'local' }">
        <input v-model="draft.imageUpload.defaultTarget" type="radio" value="local" />
        <span><strong>本地 assets</strong><small>默认、离线可用</small></span>
      </label>
      <label :class="{ selected: draft.imageUpload.defaultTarget === 'github' }">
        <input v-model="draft.imageUpload.defaultTarget" type="radio" value="github" />
        <span><strong>GitHub 图床</strong><small>失败后自动本地落盘</small></span>
      </label>
    </div>

    <div v-if="draft.imageUpload.defaultTarget === 'github'" class="sub-block">
      <header class="sub-heading">
        <strong>GitHub 图床配置</strong>
        <span>仅在上传图片到 GitHub 时使用</span>
      </header>
      <div class="field-grid cols-2">
        <label class="field">
          <span>仓库</span>
          <input
            v-model="draft.imageUpload.github.repository"
            placeholder="tnotesjs/imgs-2026 或 GitHub 地址"
          />
        </label>
        <label class="field">
          <span>分支</span>
          <input v-model="draft.imageUpload.github.branch" placeholder="main" />
        </label>
        <label class="field">
          <span>仓库内路径</span>
          <input v-model="draft.imageUpload.github.path" placeholder="/" />
        </label>
        <label class="field">
          <span>文件名格式</span>
          <input
            v-model="draft.imageUpload.github.fileNameFormat"
            placeholder="${YY}-${MM}-${DD}-${HH}-${mm}-${ss}"
          />
        </label>
      </div>
      <label class="field">
        <span>CDN 模板</span>
        <input v-model="draft.imageUpload.github.cdnTemplate" />
        <small>支持 ${username}、${repository}、${branch}、${filepath}</small>
      </label>
      <label class="field">
        <span>GitHub Token</span>
        <input
          v-model="token"
          type="password"
          autocomplete="off"
          :disabled="clearToken"
          :placeholder="
            tokenStatus.configured
              ? '已配置；输入新值可替换'
              : 'fine-grained PAT（Contents: write）'
          "
          @change="applyToken"
        />
        <small>{{ tokenHint }}</small>
      </label>
      <p
        v-if="!draft.imageUpload.github.repository.trim() || !tokenStatus.configured"
        class="warn-hint"
      >
        尚未完成配置（缺少仓库或 Token）：此时上传会回退到本地 assets 目录。
      </p>
      <div class="token-actions">
        <label v-if="tokenStatus.configured" class="switch-field danger">
          <input v-model="clearToken" type="checkbox" @change="applyToken" />
          <span>移除已保存的 Token</span>
        </label>
        <button
          type="button"
          class="btn-ghost"
          :disabled="busy || clearToken"
          @click="validateGitHub(draft)"
        >
          验证 GitHub 配置
        </button>
      </div>
    </div>

    <div class="sub-block">
      <header class="sub-heading">
        <strong>图片压缩</strong>
        <span>
          {{
            draft.imageUpload.optimize.encoder === 'oxipng'
              ? '无损重压 PNG，更小但较慢（秒级）；仅支持 PNG，不转格式不缩放。粘贴 / 图床上传与资源面板共用。'
              : '有损重编码，优先速度和体积。粘贴与图床上传自动套用；资源面板整理仍须预览后执行。'
          }}
        </span>
      </header>
      <div class="field-grid cols-2">
        <label class="field">
          <span>编码器</span>
          <select v-model="draft.imageUpload.optimize.encoder">
            <option value="sharp">sharp（有损，快）</option>
            <option value="oxipng">oxipng（无损，慢）</option>
          </select>
        </label>
        <label class="field">
          <span>压缩强度</span>
          <select v-model="draft.imageUpload.optimize.strength">
            <option value="low">低 · 少压，偏清晰</option>
            <option value="medium">中 · 均衡（默认）</option>
            <option value="high">高 · 多压，偏体积</option>
          </select>
        </label>
        <label v-if="draft.imageUpload.optimize.encoder !== 'oxipng'" class="field">
          <span>默认输出</span>
          <select v-model="draft.imageUpload.optimize.outputFormat">
            <option value="keep">保持原格式</option>
            <option value="webp">WebP</option>
            <option value="jpeg">JPEG</option>
          </select>
        </label>
      </div>
    </div>

    <ImageOptimizePlayground :draft="draft" />
  </section>
</template>

<style src="./settingsShared.css" scoped></style>

<style scoped>
.target-choice {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
  margin-bottom: 12px;
}

.target-choice > label {
  display: flex;
  align-items: center;
  gap: 9px;
  border: 1px solid var(--border);
  border-radius: 9px;
  background: var(--input-bg);
  padding: 10px 11px;
  cursor: pointer;
}

.target-choice > label.selected {
  border-color: var(--accent);
  background: var(--selected);
}

.target-choice > label input {
  accent-color: var(--accent);
  margin: 0;
}

.target-choice span {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.target-choice strong {
  color: var(--text);
  font-size: 10px;
}

.target-choice small {
  color: var(--muted);
  font-size: 9px;
}

.warn-hint {
  margin: 10px 0 0;
  color: var(--danger);
  font-size: 9px;
  line-height: 1.5;
}

.token-actions {
  display: flex;
  align-items: center;
  gap: 18px;
  margin-top: 10px;
  justify-content: space-between;
}

.btn-ghost {
  margin-left: auto;
  height: 30px;
  border: 1px solid var(--border-strong);
  border-radius: 7px;
  background: transparent;
  color: var(--text);
  cursor: pointer;
  padding: 0 12px;
  font-size: 10px;
}

.btn-ghost:hover:not(:disabled) {
  border-color: var(--accent);
  background: var(--hover);
}

.btn-ghost:disabled {
  opacity: 0.5;
  cursor: default;
}
</style>
