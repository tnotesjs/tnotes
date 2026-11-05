<script setup lang="ts">
defineProps<{ name: string; size?: number }>()
</script>

<template>
  <svg
    class="app-icon"
    :width="size ?? 18"
    :height="size ?? 18"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.8"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <template v-if="name === 'menu'">
      <path d="M4 6h16M4 12h16M4 18h16" />
    </template>
    <template v-else-if="name === 'new'">
      <path d="M6 3h9l3 3v15H6zM14 3v4h4M12 10v7M8.5 13.5h7" />
    </template>
    <template v-else-if="name === 'folder' || name === 'openProject'">
      <path d="M3 6h7l2 2h9v11H3z" />
      <path v-if="name === 'openProject'" d="m10 15 2 2 4-4" />
    </template>
    <template v-else-if="name === 'save'">
      <path d="M5 3h12l2 2v16H5zM8 3v6h8V3M8 15h8" />
    </template>
    <template v-else-if="name === 'download'">
      <path d="M12 3v12m-4-4 4 4 4-4M4 19h16" />
    </template>
    <template v-else-if="name === 'undo'">
      <path d="m9 7-5 5 5 5M4 12h9a6 6 0 0 1 6 6" />
    </template>
    <template v-else-if="name === 'redo'">
      <path d="m15 7 5 5-5 5M20 12h-9a6 6 0 0 0-6 6" />
    </template>
    <template v-else-if="name === 'search'">
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="m16 16 4.5 4.5" />
    </template>
    <template v-else-if="name === 'collapse'">
      <path d="M5 5h6v6H5zM13 13h6v6h-6zM8 11v5h5M15 3v7m-3-3 3 3 3-3" />
    </template>
    <template v-else-if="name === 'focus'">
      <path d="M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5" />
      <circle cx="12" cy="12" r="3" />
    </template>
    <template v-else-if="name === 'zoomIn' || name === 'zoomOut'">
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="m16 16 4.5 4.5M7.5 10.5h6" />
      <path v-if="name === 'zoomIn'" d="M10.5 7.5v6" />
    </template>
    <template v-else-if="name === 'fit'">
      <path d="M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5M8 8h8v8H8z" />
    </template>
    <template v-else-if="name === 'more'">
      <circle cx="5" cy="12" r="1" fill="currentColor" />
      <circle cx="12" cy="12" r="1" fill="currentColor" />
      <circle cx="19" cy="12" r="1" fill="currentColor" />
    </template>
    <template v-else-if="name === 'image'">
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <circle cx="9" cy="9" r="2" />
      <path d="m4 17 5-5 3 3 2-2 6 6" />
    </template>
    <template v-else-if="name === 'link'">
      <path
        d="M10 13a5 5 0 0 0 7.5.5l2-2a5 5 0 0 0-7-7l-1.2 1.2M14 11a5 5 0 0 0-7.5-.5l-2 2a5 5 0 0 0 7 7l1.2-1.2"
      />
    </template>
    <template v-else-if="name === 'code'">
      <path d="m8 5-5 7 5 7M16 5l5 7-5 7M14 3l-4 18" />
    </template>
    <template v-else-if="name === 'trash'">
      <path d="M4 7h16M9 7V4h6v3M6 7l1 14h10l1-14M10 11v6M14 11v6" />
    </template>
    <template v-else-if="name === 'copy'">
      <rect x="8" y="8" width="12" height="12" rx="2" />
      <path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3" />
    </template>
    <template v-else-if="name === 'check'">
      <rect x="3" y="3" width="18" height="18" rx="3" />
      <path d="m7 12 3 3 7-7" />
    </template>
    <template v-else-if="name === 'removeLink'">
      <path d="M9 15 7.5 16.5a5 5 0 0 1-7-7L3 7M15 9l1.5-1.5a5 5 0 0 1 7 7L21 17M3 3l18 18" />
    </template>
    <template v-else-if="name === 'edit'">
      <path d="m4 20 4.2-1 10.6-10.6a2.1 2.1 0 0 0-3-3L5.2 16zM14.8 6.2l3 3" />
    </template>
    <template v-else-if="name === 'clearFormat'">
      <path
        d="m4 17 7.5-11.5a2 2 0 0 1 2.8-.5l4.2 2.8a2 2 0 0 1 .5 2.8L12.2 21H7zM8.5 14.5l5.8 3.8M3 21h18"
      />
    </template>
    <template v-else-if="name === 'close'">
      <path d="M5 5l14 14M19 5 5 19" />
    </template>
    <template v-else-if="name === 'outline'">
      <circle cx="5" cy="6" r="1.2" fill="currentColor" />
      <circle cx="5" cy="12" r="1.2" fill="currentColor" />
      <circle cx="5" cy="18" r="1.2" fill="currentColor" />
      <path d="M9 6h11M9 12h8M9 18h10" />
    </template>
    <template v-else-if="name === 'mindmap'">
      <circle cx="12" cy="5" r="2.5" />
      <circle cx="5" cy="18" r="2.5" />
      <circle cx="19" cy="18" r="2.5" />
      <path d="M12 7.5V12M5 15.5V12h14v3.5" />
    </template>
    <template v-else-if="name === 'source'">
      <path d="m9 6-6 6 6 6M15 6l6 6-6 6M14 3l-4 18" />
    </template>
  </svg>
</template>

<style scoped>
.app-icon {
  display: block;
  flex: none;
}
</style>
