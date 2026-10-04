<script setup lang="ts">
import { computed, ref, watch } from 'vue'

const props = withDefaults(defineProps<{
  id: string
  label: string
  value: number
  min?: number
  max: number
  step?: number
  disabled: boolean
  identity: string
  describe: (value: number) => string
}>(), { min: 0, step: 1 })
const emit = defineEmits<{ commit: [value: number, identity: string] }>()
const draft = ref<number | null>(null)
let heldIdentity: string | null = null
let canceled = false
const displayed = computed(() => Math.min(props.max, Math.max(props.min, draft.value ?? props.value)))

function begin() {
  if (props.disabled) return
  heldIdentity = props.identity
  canceled = false
}

function keydown(event: KeyboardEvent) {
  if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) begin()
}

function preview(event: Event) {
  if (props.disabled || canceled) return
  heldIdentity ??= props.identity
  draft.value = Number((event.target as HTMLInputElement).value)
}

function cancel() {
  draft.value = null
  heldIdentity = null
  canceled = true
}

function commit() {
  const value = draft.value
  const identity = heldIdentity
  if (!canceled && !props.disabled && value !== null && identity === props.identity) {
    emit('commit', Math.min(props.max, Math.max(props.min, value)), identity)
  }
  draft.value = null
  heldIdentity = null
}

watch(() => props.identity, cancel)
watch(() => props.disabled, (disabled) => { if (disabled) cancel() })
</script>

<template>
  <input
    :id="id"
    class="commit-slider"
    type="range"
    :aria-label="label"
    :aria-valuetext="describe(displayed)"
    :min="min"
    :max="max"
    :step="step"
    :value="displayed"
    :disabled="disabled"
    @focus="begin"
    @pointerdown="begin"
    @keydown="keydown"
    @input="preview"
    @change="commit"
    @pointercancel="cancel"
    @blur="cancel"
  />
</template>
