<script setup lang="ts">
const paths = {
  library: ['M4 4v16h16V4H4Z', 'M8 4v16', 'M12 8h4', 'M12 12h4'],
  note: ['M9 18V5l11-2v13', 'M9 8l11-2', 'M9 18c0 1.7-1.8 3-4 3s-3-1.1-3-2.5S3.8 16 6 16c1.2 0 2.2.3 3 .9', 'M20 16c0 1.7-1.8 3-4 3s-3-1.1-3-2.5S14.8 14 17 14c1.2 0 2.2.3 3 .9'],
  play: ['M8 4l13 8L8 20V4Z'],
  pause: ['M8 4v16', 'M16 4v16'],
  next: ['M5 5l11 7-11 7V5Z', 'M19 5v14'],
  previous: ['M19 5L8 12l11 7V5Z', 'M5 5v14'],
  plus: ['M12 5v14', 'M5 12h14'],
  close: ['M6 6l12 12', 'M18 6L6 18'],
  volume: ['M4 9h4l5-4v14l-5-4H4V9Z', 'M17 8c2 2 2 6 0 8', 'M20 5c4 4 4 10 0 14'],
  mute: ['M4 9h4l5-4v14l-5-4H4V9Z', 'M17 9l5 6', 'M22 9l-5 6'],
  search: ['M15 15l6 6', 'M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0'],
  queue: ['M4 5h16', 'M4 12h16', 'M4 19h10'],
  users: ['M15 8a3 3 0 1 1-6 0 3 3 0 0 1 6 0', 'M5 21v-2a7 7 0 0 1 14 0v2', 'M20 4a3 3 0 0 1 0 6', 'M21 14c1.2 1 2 2.5 2 4'],
  retry: ['M20 10a8 8 0 1 0-1 8', 'M20 4v6h-6'],
  arrow: ['M4 12h15', 'M13 6l6 6-6 6'],
  logout: ['M9 4H4v16h5', 'M10 12h11', 'M16 7l5 5-5 5']
} as const

defineProps<{ name: keyof typeof paths }>()
</script>

<template>
  <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
    <path v-for="(path, index) in paths[name]" :key="index" :d="path" />
  </svg>
</template>
