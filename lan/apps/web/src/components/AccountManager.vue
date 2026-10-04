<script setup lang="ts">
import UserRoleRow from './UserRoleRow.vue'
import { ref, watch } from 'vue'
import { CreateUserRequestSchema, LIMITS } from '@lan/shared'
import type { Role } from '@lan/shared'
import { useRoomStore } from '../stores/room'

const room = useRoomStore()
const username = ref('')
const password = ref('')
const role = ref<Role>('user')
const formError = ref<string | null>(null)
const inputSchema = CreateUserRequestSchema.omit({ requestId: true })

watch(() => room.connected && room.admin, (ready) => {
  if (ready) void room.loadUsers()
}, { immediate: true })

async function create() {
  formError.value = null
  const result = inputSchema.safeParse({ username: username.value, password: password.value, role: role.value })
  if (!result.success) {
    formError.value = '请检查账号格式与密码长度。密码需要 12–128 位，输入不会被裁剪或改写。'
    return
  }
  try {
    if (await room.createUser(result.data)) {
      username.value = ''
      role.value = 'user'
    }
  } finally {
    password.value = ''
  }
}
</script>

<template>
  <section v-if="room.admin" id="accounts" class="accounts-section" aria-labelledby="accounts-title">
    <div class="section-heading">
      <div>
        <p class="eyebrow">管理员专属</p>
        <h2 id="accounts-title">账号管理</h2>
      </div>
      <button class="button button-subtle" type="button" :disabled="!room.connected || room.usersLoading" @click="room.loadUsers()">刷新账号</button>
    </div>
    <p class="section-caption">听众可以点歌；主持人可以控制播放器与待播队列；管理员还可以管理账号。</p>
    <div class="accounts-layout">
      <form class="create-user-form surface" :aria-busy="room.busy === 'create-user'" @submit.prevent="create">
        <h3>邀请一个新账号</h3>
        <div class="field">
          <label for="new-username">账号名</label>
          <input id="new-username" v-model="username" name="new-username" autocomplete="off" autocapitalize="none" :spellcheck="false" :minlength="LIMITS.usernameMinLength" :maxlength="LIMITS.usernameMaxLength" pattern="[a-z0-9][a-z0-9._-]*" aria-describedby="username-help" required :disabled="!room.canWrite" />
          <small id="username-help">3–32 位小写字母、数字、点、下划线或短横线；以字母或数字开头。</small>
        </div>
        <div class="field">
          <label for="new-password">初始密码</label>
          <input id="new-password" v-model="password" name="new-password" type="password" autocomplete="new-password" :minlength="LIMITS.passwordMinLength" :maxlength="LIMITS.passwordMaxLength" aria-describedby="password-help" required :disabled="!room.canWrite" />
          <small id="password-help">12–128 位。请通过私密渠道告知账号使用者。</small>
        </div>
        <div class="field">
          <label for="new-role">角色</label>
          <select id="new-role" v-model="role" :disabled="!room.canWrite">
            <option value="user">听众 · user</option>
            <option value="dj">主持人 · dj</option>
            <option value="admin">管理员 · admin</option>
          </select>
        </div>
        <p v-if="formError" class="inline-error" role="alert">{{ formError }}</p>
        <button class="button button-primary" type="submit" :disabled="!room.canWrite">{{ room.busy === 'create-user' ? '正在创建…' : '创建账号' }}</button>
      </form>
      <div class="user-list-panel surface" :aria-busy="room.usersLoading">
        <h3>账号与权限</h3>
        <p class="form-footnote">角色更改会使该账号的所有会话退出。至少保留一位管理员。</p>
        <p v-if="room.usersLoading" class="loading-note" role="status">正在读取账号…</p>
        <p v-else-if="room.usersError" class="inline-error" role="alert">{{ room.usersError }}</p>
        <p v-else-if="!room.users.length" class="empty-state">暂无可显示的账号。</p>
        <ul v-else class="user-list" aria-label="应用账号">
          <li v-for="user in room.users" :key="user.id">
            <UserRoleRow :user="user" :self="user.id === room.session?.user.id" :disabled="!room.canWrite" :saving="room.busy === `role:${user.id}`" @save="room.updateRole" />
          </li>
        </ul>
      </div>
    </div>
  </section>
</template>
