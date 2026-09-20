<script setup lang="ts">
/**
 * 笔记「完成」开关（空心环 = 待完成，实心 = 已完成）。
 *
 * 目录树与笔记面包屑共用**同一个组件**：样式只有一份，两个入口不会各自漂移
 * （验收要求两处样式一致）。形状是主信号（空心 / 实心），颜色只是强化。
 *
 * 只管画与点击，不认识 note 节点：状态由调用方给，切换由调用方做 ——
 * 目录树走 `toggleDone(node)`，面包屑走当前笔记的活节点，两边语义在各自上下文里。
 */
defineProps<{
  done: boolean
}>()

const emit = defineEmits<{
  toggle: []
}>()
</script>

<template>
  <button
    type="button"
    class="done-toggle"
    :class="{ done }"
    :aria-label="done ? '标记为未完成' : '标记为完成'"
    @click="emit('toggle')"
  >
    <span class="done-dot" aria-hidden="true" />
  </button>
</template>

<style scoped>
/*
 * 完成状态用「形状优先」的圆点表达，和站点侧栏（`.tn-site-sidebar-status`）同一套：
 * 空心环 = 待完成，实心 = 已完成；颜色只是强化，不是唯一信号。按钮本身只做点击
 * 目标与无障碍标签，视觉全交给里面那颗点。
 */
.done-toggle {
  width: 14px;
  height: 14px;
  flex: none;
  display: grid;
  place-items: center;
  border: 0;
  background: transparent;
  color: inherit;
  cursor: pointer;
  padding: 0;
}

.done-dot {
  width: 7px;
  height: 7px;
  border: 1.5px solid var(--warning);
  border-radius: 50%;
  background: transparent;
}

.done-toggle.done .done-dot {
  border-color: var(--success);
  background: var(--success);
}
</style>
