<template>
  <div class="tn-article-tools">
    <a
      v-if="deskUrl"
      :href="deskUrl"
      class="tn-article-tool tn-article-tool-desk"
      title="在 Desk 中打开这篇笔记（需本机已安装 Desk，并已添加该知识库）"
      aria-label="在 Desk 中打开这篇笔记"
      ><SiteIcon name="desk"
    /></a>
    <button
      v-else-if="deskFallback"
      type="button"
      class="tn-article-tool tn-article-tool-desk"
      title="在 Desk 中打开这篇笔记"
      aria-label="在 Desk 中打开这篇笔记"
      @click="message = '知识库或笔记缺少 id，无法在 Desk 中打开'"
    >
      <SiteIcon name="desk" />
    </button>
    <a
      v-if="repoUrl"
      :href="repoUrl"
      target="_blank"
      rel="noopener noreferrer"
      class="tn-article-tool"
      title="在 GitHub 中打开这篇笔记"
      aria-label="在 GitHub 中打开这篇笔记"
      ><SiteIcon name="github"
    /></a>
    <div class="tn-article-tools-end">
      <button
        type="button"
        class="tn-article-tool"
        :title="wide ? '超宽显示' : '标准页宽'"
        :aria-label="wide ? '超宽显示' : '标准页宽'"
        :aria-pressed="wide"
        @click="$emit('toggle-width')"
      >
        <SiteIcon :name="wide ? 'pageWidthWide' : 'pageWidth'" />
      </button>
      <button
        type="button"
        class="tn-article-tool"
        title="复制笔记原文"
        aria-label="复制笔记原文"
        @click="copyNote"
      >
        <SiteIcon name="copy" />
      </button>
      <button
        v-if="canFold"
        type="button"
        class="tn-article-tool"
        :title="folded ? '展开所有标题' : '折叠所有标题'"
        :aria-label="folded ? '展开所有标题' : '折叠所有标题'"
        :aria-pressed="folded"
        @click="$emit('toggle-fold')"
      >
        <SiteIcon name="foldAll" />
      </button>
    </div>
    <p v-if="message" class="tn-article-toast" role="status">{{ message }}</p>
  </div>
</template>
<script setup lang="ts">
import { ref, onBeforeUnmount } from 'vue'
import SiteIcon from './SiteIcon.vue'
import { copyText } from '../clipboard'
const props = defineProps<{
  repoUrl: string
  source: string
  folded: boolean
  canFold: boolean
  wide: boolean
  deskUrl?: string
  deskFallback?: boolean
}>()
defineEmits<{ 'toggle-fold': []; 'toggle-width': [] }>()
const message = ref('')
let timer: ReturnType<typeof setTimeout> | undefined
async function copyNote() {
  try {
    await copyText(props.source)
    message.value = '已复制笔记原文'
  } catch {
    message.value = '复制失败，请重试'
  }
  clearTimeout(timer)
  timer = setTimeout(() => {
    message.value = ''
  }, 2500)
}
onBeforeUnmount(() => clearTimeout(timer))
</script>
