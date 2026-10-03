<script setup lang="ts">
import { ref, watch } from 'vue'
import type { PublicUser, Role } from '@lan/shared'
import { roleLabels } from '../utils/format'

const props = defineProps<{ user: PublicUser, self: boolean, disabled: boolean, saving: boolean }>()
const emit = defineEmits<{ save: [userId: string, role: Role] }>()
const selected = ref<Role>(props.user.role)
watch(() => props.user.role, (role) => { selected.value = role })

function save() {
  if (props.disabled || selected.value === props.user.role) return
  if (props.self && !window.confirm('更改自己的角色会立即退出登录，并可能失去账号管理权限。确认继续？')) return
  emit('save', props.user.id, selected.value)
}
</script>

<template>
  <form class="user-row" @submit.prevent="save">
    <div class="user-identity">
      <strong>{{ user.username }} <span v-if="self" class="own-label">我</span></strong>
      <span class="muted">{{ roleLabels[user.role] }}</span>
    </div>
    <div class="user-role-controls">
      <label :for="`role-${user.id}`" class="sr-only">{{ user.username }} 的新角色</label>
      <select :id="`role-${user.id}`" v-model="selected" :disabled="disabled">
        <option value="user">听众 · user</option>
        <option value="dj">主持人 · dj</option>
        <option value="admin">管理员 · admin</option>
      </select>
      <button class="button button-subtle" type="submit" :disabled="disabled || selected === user.role" :aria-label="`保存 ${user.username} 的角色`">{{ saving ? '保存中' : '保存' }}</button>
    </div>
  </form>
</template>
