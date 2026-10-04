<template>
  <div
    v-if="show"
    class="rightClickMenu"
    :style="{ left: x + 'px', top: y + 'px' }"
    @mousedown.stop
  >
    <div v-if="showPin" class="menuItem" @click="handlePin">📌 Pin</div>
    <div class="menuItem" @click="(e) => handlePronounce(e, 'en-GB')">📢 Pronounce（英）</div>
    <div class="menuItem" @click="(e) => handlePronounce(e, 'en-US')">📢 Pronounce（美）</div>
    <div class="menuItem" @click="(e) => handlePronounceAll(e, 'en-GB')">
      📢 Pronounce All（英）
    </div>
    <div class="menuItem" @click="(e) => handlePronounceAll(e, 'en-US')">
      📢 Pronounce All（美）
    </div>
    <div v-if="showAutoShowCard" class="menuItem" @click="handleAutoShowCard">
      🔍 Auto Show Card（{{ isAutoShowCard ? '关' : '开' }}）
    </div>
    <div class="menuItem" @click="handleCheckAll">✅ Check All</div>
    <div class="menuItem" @click="handleReset">❌ Reset</div>
  </div>
</template>

<script setup>
defineProps({
  show: Boolean,
  isAutoShowCard: Boolean,
  x: Number,
  y: Number,
  showPin: {
    type: Boolean,
    default: true
  },
  showAutoShowCard: {
    type: Boolean,
    default: true
  }
})

const emit = defineEmits(['pin', 'pronounce', 'pronounceAll', 'autoShowCard', 'checkAll', 'reset'])
const handlePin = (e) => {
  emit('pin')
  e.preventDefault()
}
const handleAutoShowCard = () => {
  emit('autoShowCard')
}
const handlePronounce = (e, lang) => {
  emit('pronounce', lang)
  e.preventDefault()
}
const handlePronounceAll = (e, lang) => {
  emit('pronounceAll', lang)
  e.preventDefault()
}
const handleCheckAll = () => {
  emit('checkAll')
}
const handleReset = () => {
  emit('reset')
}
</script>

<style scoped lang="scss">
.rightClickMenu {
  position: fixed;
  z-index: 99999;
  background: var(--tn-c-bg-elv, var(--tn-c-bg));
  border: 1px solid var(--tn-c-divider);
  border-radius: 8px;
  box-shadow: var(--tn-shadow-2);
  font-size: 13px;
  color: var(--tn-c-text);
  cursor: pointer;
  user-select: none;
}

.menuItem {
  padding: 8px 16px;

  &:hover {
    background: var(--tn-c-hover);
  }
}
</style>
