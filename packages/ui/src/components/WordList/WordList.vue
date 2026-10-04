<script setup>
import { marked } from 'marked'
import { computed, ref, onMounted, onUnmounted, nextTick } from 'vue'

import RightClickMenu from './RightClickMenu.vue'
import { WORD_LIST_FEATURES_FULL, resolveWordListFeatures } from './wordListFeatures'

const DEFAULT_WORDS_BASE_URL = 'https://github.com/tnotesjs/en-words/blob/main/'
const DEFAULT_WORDS_RAW_BASE_URL =
  'https://raw.githubusercontent.com/tnotesjs/en-words/refs/heads/main/'

const props = defineProps({
  words: {
    type: Array,
    default: () => []
  },
  needSort: {
    type: Boolean,
    default: false
  },
  wordsBaseUrl: {
    type: String,
    default: DEFAULT_WORDS_BASE_URL
  },
  wordsRawBaseUrl: {
    type: String,
    default: DEFAULT_WORDS_RAW_BASE_URL
  },
  /** Capability overrides; omit for full web/core behavior. */
  features: {
    type: Object,
    default: () => ({ ...WORD_LIST_FEATURES_FULL })
  }
})

const features = computed(() => resolveWordListFeatures(props.features))

const isMobile = computed(() => {
  if (typeof navigator === 'undefined') return false
  return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent)
})

// checkbox ---------------------------------------------------

const pathname = typeof window !== 'undefined' ? window.location.pathname : ''
const sortedWords = computed(() => {
  const unique = [...new Set(props.words ?? [])]
  if (!props.needSort) return unique
  return unique.sort((a, b) => a.toLowerCase().charCodeAt(0) - b.toLowerCase().charCodeAt(0))
})
const islandWords = computed(() => encodeURIComponent(JSON.stringify(sortedWords.value)))
const checkedStates = ref({})

const updateCheckedState = (word, isChecked) => {
  const key = `${pathname}-${word}`
  checkedStates.value[word] = isChecked
  localStorage.setItem(key, isChecked)
}

const checkAll = () => {
  Object.keys(checkedStates.value).forEach((word) => {
    updateCheckedState(word, true)
  })
  hideContextMenu()
}

const reset = () => {
  sortedWords.value.forEach((word) => {
    const key = `${pathname}-${word}`
    localStorage.removeItem(key)
    checkedStates.value[word] = false
  })
  hideContextMenu()
}

// word card ---------------------------------------------------

const topZIndex = ref(10000)

const isAutoShowCard = ref(false)

// 卡片状态
const showCard = ref(false)
const cardX = ref(0)
const cardY = ref(0)
const cardContent = ref('')
const wordCache = ref({})
const wordMarkdown = ref({})

// 加载失败的词汇（也就是词库中不存在的词汇）
const failedWords = ref({})

// pinnedCards: { id, word, x, y, isDragging }
const pinnedCards = ref([])
let draggingCard = null
let offsetX = 0
let offsetY = 0

const CARD_DEFAULT_WIDTH = 400
const CARD_DEFAULT_HEIGHT = 500

let resizingCard = null
let startX = 0
let startY = 0
let startWidth = 0
let startHeight = 0

// 右键菜单状态
const contextMenuVisible = ref(false)
const contextMenuX = ref(0)
const contextMenuY = ref(0)
let currentWordForContextMenu = null

// 防抖计时器
let hoverTimer = null

function wordSlug(word) {
  return encodeURIComponent(word.toLowerCase().replaceAll(/\s/g, '_'))
}

function wordGithubUrl(word) {
  return `${props.wordsBaseUrl}${wordSlug(word)}.md`
}

async function ensureWord(word) {
  if (wordCache.value[word]) return
  const url = `${props.wordsRawBaseUrl}${wordSlug(word)}.md`
  try {
    const res = await fetch(url)
    if (res.ok) {
      const text = await res.text()
      wordMarkdown.value[word] = text
      wordCache.value[word] = marked.parse(text)
    } else {
      wordCache.value[word] = `<em>无法加载单词内容</em>`
      failedWords.value[word] = true
    }
  } catch (err) {
    console.error(err)
    wordCache.value[word] = `<em>加载失败</em>`
    failedWords.value[word] = true
  }
}

const copiedCardId = ref(null)
let copiedTimer = null

async function copyCardMarkdown(card, event) {
  event.stopPropagation()
  const markdown = wordMarkdown.value[card.word]
  if (!markdown) return
  try {
    await navigator.clipboard.writeText(markdown)
  } catch {
    const field = document.createElement('textarea')
    field.value = markdown
    field.setAttribute('readonly', '')
    field.style.position = 'fixed'
    field.style.left = '-9999px'
    document.body.append(field)
    field.select()
    document.execCommand('copy')
    field.remove()
  }
  copiedCardId.value = card.id
  clearTimeout(copiedTimer)
  copiedTimer = setTimeout(() => {
    copiedCardId.value = null
  }, 1500)
}

function openCardOnGithub(card, event) {
  event.stopPropagation()
  window.open(wordGithubUrl(card.word), '_blank', 'noopener')
}

/**
 * 显示单词卡片
 */
const showWordCard = async (e, word) => {
  if (!features.value.enableCards || !features.value.enableWordData) {
    return Promise.resolve()
  }
  cardContent.value = '<em>加载中……</em>'
  return new Promise((resolve) => {
    clearTimeout(hoverTimer)
    hoverTimer = setTimeout(async () => {
      const { clientX, clientY } = e
      cardX.value = clientX + 10
      cardY.value = clientY + 10
      showCard.value = true

      await ensureWord(word)
      cardContent.value = wordCache.value[word] || `<em>加载失败</em>`
      resolve()
    }, 300)
  })
}

// const convertMarkdownToHTML = (text) => {
//   const lines = text.trim().split('\n')
//   let stack = [{ level: -1, html: [] }]

//   for (let line of lines) {
//     const match = line.match(/^(\s*)-\s(.*)/)
//     if (!match) continue

//     const indent = match[1].length
//     const content = match[2]
//     const currentLevel = stack[stack.length - 1]

//     const imageMatch = content.match(/^!\$$(.+?)$$/)
//     const processedContent = imageMatch
//       ? `<img src="${imageMatch[1]}" alt="" />`
//       : content

//     // 1. 深了：如果缩进比上一级更深，开启新子列表
//     if (indent > currentLevel.level) {
//       stack.push({ level: indent, html: [] })
//     }
//     // 2. 浅了：如果缩进更浅，关闭之前的列表直到匹配层级
//     else if (indent < currentLevel.level) {
//       while (stack.length > 1 && stack[stack.length - 2].level >= indent) {
//         const closed = stack.pop()
//         const innerHTML = closed.html.join('')
//         stack[stack.length - 1].html.push(`<ul>${innerHTML}</ul>`)
//       }
//     }
//     // 3. 一致：stack[-1] 是与当前 indent 层级一致的节点，添加当前 li 内容。
//     stack[stack.length - 1].html.push(`<li>${processedContent}</li>`)
//   }

//   // 清理栈中剩余的 ul
//   while (stack.length > 1) {
//     const closed = stack.pop()
//     const innerHTML = closed.html.join('')
//     stack[stack.length - 1].html.push(`<ul>${innerHTML}</ul>`)
//   }
//   console.log(stack)

//   return stack[0].html.join('')
// }

const preloadWords = async () => {
  if (!features.value.enableWordData) return
  const wordsToPreload = sortedWords.value
  if (!wordsToPreload.length) return

  for (let i = 0; i < wordsToPreload.length; i++) {
    const word = wordsToPreload[i]

    if (wordCache.value[word]) continue
    await ensureWord(word)

    // 可选：加个延迟避免并发请求过多
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
}

const pinCard = (word) => {
  if (!features.value.enableCards) return
  // 如果已存在该卡片则不再重复添加
  if (pinnedCards.value.some((card) => card.word === word)) return

  pinnedCards.value.push({
    id: Date.now(),
    word,
    x: cardX.value,
    y: cardY.value,
    content: cardContent.value,
    width: CARD_DEFAULT_WIDTH,
    height: CARD_DEFAULT_HEIGHT,
    zIndex: topZIndex.value++
  })
}

const bringToFront = (card) => {
  const index = pinnedCards.value.indexOf(card)
  if (index > -1) {
    pinnedCards.value = [
      ...pinnedCards.value.slice(0, index),
      ...pinnedCards.value.slice(index + 1),
      { ...card, zIndex: topZIndex.value++ }
    ]
  }
}

const removeCard = (id) => {
  pinnedCards.value = pinnedCards.value.filter((card) => card.id !== id)
}

const startDrag = (card, e) => {
  draggingCard = card
  offsetX = e.clientX - card.x
  offsetY = e.clientY - card.y
  document.addEventListener('mousemove', onDragging)
  document.addEventListener('mouseup', stopDrag)
}

const onDragging = (e) => {
  if (!draggingCard) return
  draggingCard.x = e.clientX - offsetX
  draggingCard.y = e.clientY - offsetY
}

const stopDrag = () => {
  draggingCard = null
  document.removeEventListener('mousemove', onDragging)
  document.removeEventListener('mouseup', stopDrag)
}

const showContextMenu = (e, word) => {
  e.preventDefault()
  currentWordForContextMenu = word
  contextMenuX.value = e.clientX
  contextMenuY.value = e.clientY
  contextMenuVisible.value = true
}

const hideContextMenu = () => {
  contextMenuVisible.value = false
}

const handleContextMenuPin = () => {
  if (!features.value.enableContextMenuPin || !features.value.enableCards) {
    hideContextMenu()
    return
  }
  if (currentWordForContextMenu) {
    const word = currentWordForContextMenu
    // 提前加载内容
    showWordCard({ clientX: contextMenuX.value, clientY: contextMenuY.value }, word).then(() => {
      pinCard(word)
      showCard.value = false
    })
    hideContextMenu()
  }
}

const startResize = (card, e) => {
  resizingCard = card
  startX = e.clientX
  startY = e.clientY
  startWidth = card.width
  startHeight = card.height

  document.addEventListener('mousemove', onResizing)
  document.addEventListener('mouseup', stopResize)
}

const onResizing = (e) => {
  if (!resizingCard) return

  const newWidth = startWidth + (e.clientX - startX)
  const newHeight = startHeight + (e.clientY - startY)

  // 设置最小尺寸
  if (newWidth > 200) resizingCard.width = newWidth
  if (newHeight > 100) resizingCard.height = newHeight
}

const stopResize = () => {
  resizingCard = null
  document.removeEventListener('mousemove', onResizing)
  document.removeEventListener('mouseup', stopResize)
}

/**
 * 处理鼠标离开事件
 */
const handleMouseLeave = () => {
  setTimeout(() => {
    hideWordCard()
  }, 100)
}

/**
 * 隐藏单词卡片
 */
const hideWordCard = () => {
  showCard.value = false
}

// pronounce ----------------------------------------------------------

let currentPronounceAllIndex = ref(0)
let isPronouncingAll = ref(false)
let pronounceAllInterval = null

const handlePronounceAll = (lang) => {
  if (isPronouncingAll.value) {
    // 如果正在播放，就停止
    stopPronounceAll()
    return
  }

  const wordsToSpeak = sortedWords.value
  if (!wordsToSpeak.length) return

  currentPronounceAllIndex.value = 0
  isPronouncingAll.value = true

  const speakNext = async () => {
    if (!isPronouncingAll.value || currentPronounceAllIndex.value >= wordsToSpeak.length) {
      stopPronounceAll()
      return
    }

    const word = wordsToSpeak[currentPronounceAllIndex.value]
    const utterance = new SpeechSynthesisUtterance(word)
    utterance.lang = lang
    speechSynthesis.speak(utterance)

    await nextTick()
    currentPronounceAllIndex.value++
  }

  speakNext()

  // 每隔 1.5 秒读一个词
  pronounceAllInterval = setInterval(speakNext, 1500)

  hideContextMenu()
}

const stopPronounceAll = () => {
  isPronouncingAll.value = false
  if (pronounceAllInterval) {
    clearInterval(pronounceAllInterval)
    pronounceAllInterval = null
  }
  speechSynthesis.cancel() // 停止所有未完成的语音
}

const handlePronounce = (word, lang = 'en-GB') => {
  if ('speechSynthesis' in window) {
    stopPronounceAll()

    const utterance = new SpeechSynthesisUtterance(word)
    utterance.lang = lang
    speechSynthesis.speak(utterance)
    hideContextMenu()
  } else {
    alert('您的浏览器不支持语音功能，请尝试使用 Chrome 或 Edge 浏览器。')
  }
}

// hooks ----------------------------------------------------------

onMounted(() => {
  sortedWords.value.forEach((word) => {
    const key = `${pathname}-${word}`
    const storedState = localStorage.getItem(key)
    checkedStates.value[word] = storedState === 'true'
  })

  if (!isMobile.value && features.value.enableWordData) preloadWords()

  // 添加点击事件监听以隐藏右键菜单
  if (typeof document !== 'undefined') {
    document.body.addEventListener('click', hideContextMenu)
  }
})

/**
 * 销毁时清理定时器
 */
onUnmounted(() => {
  clearTimeout(hoverTimer)
  clearTimeout(copiedTimer)
  if (typeof document !== 'undefined') {
    document.removeEventListener('mousemove', onDragging)
    document.removeEventListener('mouseup', stopDrag)
    document.body.removeEventListener('click', hideContextMenu)
  }
})
</script>

<template>
  <div
    class="tn-word-list"
    data-tn-island="word-list"
    :data-words="islandWords"
    :data-need-sort="needSort ? 'true' : 'false'"
  >
    <ol>
      <li
        v-for="(word, index) in sortedWords"
        :key="word"
        :class="{
          pronounced: isPronouncingAll && currentPronounceAllIndex === index + 1
        }"
      >
        <span class="index">{{ index + 1 }}.</span>
        <input
          type="checkbox"
          :id="word"
          :checked="checkedStates[word]"
          @change="(e) => updateCheckedState(word, e.target.checked)"
        />
        <label :for="word">
          <a
            :href="`${props.wordsBaseUrl}${encodeURIComponent(
              word.toLowerCase().replaceAll(/\s/g, '_')
            )}.md`"
            :class="{
              lineThrough: checkedStates[word],
              textRed: failedWords[word]
            }"
            @mouseenter="(e) => features.enableCards && isAutoShowCard && showWordCard(e, word)"
            @mouseleave="handleMouseLeave"
            @contextmenu="(e) => showContextMenu(e, word)"
            @click.ctrl.exact="(e) => handlePronounce(word)"
          >
            {{ word }}
          </a>
        </label>
      </li>
    </ol>

    <div
      class="wordCard"
      :style="{ left: cardX + 'px', top: cardY + 'px' }"
      v-if="features.enableCards && showCard"
    >
      <div class="wordCardContent" v-html="cardContent"></div>
    </div>

    <!-- pinned cards -->
    <template v-if="features.enableCards">
      <div
        v-for="card in pinnedCards"
        :key="card.id"
        class="wordCard"
        :style="{
          left: card.x + 'px',
          top: card.y + 'px',
          width: card.width + 'px',
          height: card.height + 'px',
          zIndex: card.zIndex
        }"
        @mousedown="(e) => startDrag(card, e)"
        @click="bringToFront(card)"
      >
        <div class="wordCardTools">
          <button
            type="button"
            class="cardTool"
            aria-label="在 GitHub 打开"
            title="在 GitHub 打开"
            @mousedown.stop
            @click.stop="openCardOnGithub(card, $event)"
          >
            <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
              <path
                fill="currentColor"
                d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8"
              />
            </svg>
          </button>
          <button
            type="button"
            class="cardTool"
            :aria-label="copiedCardId === card.id ? '已复制' : '复制 Markdown'"
            :title="copiedCardId === card.id ? '已复制' : '复制 Markdown'"
            @mousedown.stop
            @click.stop="copyCardMarkdown(card, $event)"
          >
            <svg
              v-if="copiedCardId !== card.id"
              viewBox="0 0 24 24"
              width="16"
              height="16"
              aria-hidden="true"
            >
              <path
                fill="none"
                stroke="currentColor"
                stroke-width="1.8"
                d="M9 9h10v10H9zM5 15V5h10"
              />
            </svg>
            <svg v-else viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
              <path
                fill="none"
                stroke="currentColor"
                stroke-width="1.8"
                stroke-linecap="round"
                stroke-linejoin="round"
                d="m5 12 5 5L20 7"
              />
            </svg>
          </button>
        </div>
        <div class="wordCardContentWrapper">
          <div class="wordCardContent" v-html="card.content"></div>
        </div>
        <button class="closeBtn" @mousedown.stop @click.stop="removeCard(card.id)">✖</button>
        <div class="resizeHandle" @mousedown.stop="startResize(card, $event)"></div>
      </div>
    </template>
  </div>

  <RightClickMenu
    v-if="!isMobile"
    :show="contextMenuVisible"
    :x="contextMenuX"
    :y="contextMenuY"
    :isAutoShowCard="isAutoShowCard"
    :showPin="features.enableContextMenuPin"
    :showAutoShowCard="features.enableContextMenuAutoShowCard"
    @pin="handleContextMenuPin"
    @pronounce="(lang) => handlePronounce(currentWordForContextMenu, lang)"
    @pronounceAll="(lang) => handlePronounceAll(lang)"
    @autoShowCard="
      () => {
        if (!features.enableContextMenuAutoShowCard) return
        isAutoShowCard = !isAutoShowCard
        hideContextMenu()
      }
    "
    @checkAll="checkAll"
    @reset="reset"
  />
</template>

<style scoped lang="scss">
.tn-word-list {
  padding: 12px 16px;
  border: 1px solid var(--tn-c-divider);
  border-radius: 8px;

  // Checkbox 样式
  input[type='checkbox'] {
    appearance: none;
    -webkit-appearance: none;
    position: relative;
    box-sizing: border-box;
    flex: none;
    width: 16px;
    height: 16px;
    margin: 0 8px;
    border: 1px solid var(--tn-c-task-check-border);
    border-radius: 4px;
    background: var(--tn-c-task-check-bg);
    cursor: pointer;

    &:checked {
      border-color: var(--tn-c-task-check);
      background: var(--tn-c-task-check);
    }

    &:checked::after {
      content: '';
      position: absolute;
      left: 4.5px;
      top: 1px;
      width: 4px;
      height: 9px;
      border: solid #fff;
      border-width: 0 2px 2px 0;
      transform: rotate(45deg);
    }
  }

  // 链接样式
  a {
    text-decoration: none;
    color: #4fc3f7;

    &:hover {
      text-decoration: underline !important;
    }

    &.lineThrough {
      color: #999;
      text-decoration: line-through;
    }

    &.textRed {
      color: #f40 !important;
    }
  }

  // 单词列表样式
  ol {
    list-style: none;
    margin: 0;
    padding-left: 0;

    li {
      display: flex;
      align-items: center;
      margin-bottom: 8px;
      transition: all 0.3s ease;

      &.pronounced {
        background-color: rgba(255, 255, 0, 0.1);
      }
    }
  }

  // 序号样式
  .index {
    margin-right: 10px;
    color: #aaa;
  }
}

.wordCard {
  position: fixed;
  z-index: 9999;
  background: var(--tn-c-bg-elv, var(--tn-c-bg));
  border: 1px solid var(--tn-c-divider);
  box-shadow: var(--tn-shadow-2);
  padding: 12px 16px;
  max-width: 600px;
  min-width: 200px;
  min-height: 100px;
  font-size: 14px;
  line-height: 1.4;
  border-radius: 8px;
  color: var(--tn-c-text);
  pointer-events: auto;
  font-family: var(--tn-font-sans, sans-serif);
  cursor: move;

  .closeBtn {
    position: absolute;
    right: 5px;
    top: 5px;
    background: none;
    border: none;
    font-size: 16px;
    cursor: pointer;
    color: var(--tn-c-text-2);

    &:hover {
      color: var(--tn-c-text);
    }
  }
}

// 卡片内容包裹器
.wordCardTools {
  position: absolute;
  top: 6px;
  left: 8px;
  z-index: 2;
  display: flex;
  gap: 2px;
}

.cardTool {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--tn-c-text-2);
  cursor: pointer;

  &:hover {
    background: var(--tn-c-hover);
    color: var(--tn-c-text);
  }
}

.wordCardContentWrapper {
  width: 100%;
  height: 100%;
  overflow: auto;
  box-sizing: border-box;
  padding-top: 22px;
}

// 卡片内容样式
.wordCardContent {
  :deep(ul) {
    margin: 0.5rem 0;
    padding-left: 1rem;
  }
}

// 调整大小手柄
.resizeHandle {
  position: absolute;
  right: 0;
  bottom: 0;
  width: 12px;
  height: 12px;
  background-color: var(--tn-c-text-2);
  cursor: nwse-resize;
  z-index: 2;
  border-radius: 50%;

  &:hover {
    background-color: var(--tn-c-text);
  }
}
</style>
