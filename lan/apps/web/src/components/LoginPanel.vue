<script setup lang="ts">
import RoomIcon from './RoomIcon.vue'
import { ref } from 'vue'
import { LIMITS, LoginRequestSchema } from '@lan/shared'
import { useRoomStore } from '../stores/room'

const room = useRoomStore()
const username = ref('')
const password = ref('')
const formError = ref<string | null>(null)

async function submit() {
  formError.value = null
  const result = LoginRequestSchema.safeParse({ username: username.value, password: password.value })
  if (!result.success) {
    formError.value = '请输入 3–32 位小写账号名和密码。账号仅支持字母、数字、点、下划线与短横线。'
    return
  }
  try {
    await room.login(result.data)
  } finally {
    password.value = ''
  }
}
</script>

<template>
  <section class="login-layout" aria-labelledby="login-title">
    <div class="login-intro">
      <p class="eyebrow">一间房 · 一份歌单</p>
      <h1 id="login-title">把喜欢的歌，<br />放在一起听。</h1>
      <p class="intro-copy">点一首歌，留一点时间。这里的每次播放，都来自同一台实体播放器。</p>
      <p class="quiet-note"><RoomIcon name="note" /> 浏览器只作遥控，不会发出声音。</p>
    </div>
    <form class="login-form surface" :aria-busy="room.authBusy" @submit.prevent="submit">
      <p class="eyebrow">进入听音室</p>
      <h2>欢迎回来</h2>
      <p class="muted">使用管理员为你创建的账号。</p>
      <div class="field">
        <label for="login-username">账号</label>
        <input id="login-username" v-model="username" name="username" autocomplete="username" autocapitalize="none" :spellcheck="false" :minlength="LIMITS.usernameMinLength" :maxlength="LIMITS.usernameMaxLength" pattern="[a-z0-9][a-z0-9._-]*" required :disabled="room.authBusy" />
      </div>
      <div class="field">
        <label for="login-password">密码</label>
        <input id="login-password" v-model="password" name="password" type="password" autocomplete="current-password" :maxlength="LIMITS.passwordMaxLength" required :disabled="room.authBusy" />
      </div>
      <p v-if="formError" class="inline-error" role="alert">{{ formError }}</p>
      <button class="button button-primary login-submit" type="submit" :disabled="room.authBusy">
        {{ room.authBusy ? '正在验证…' : '进入听音室' }}
        <RoomIcon name="arrow" />
      </button>
      <p class="form-footnote">没有公开注册，也没有默认账号。需要访问权限时，请联系听音室管理员。</p>
    </form>
  </section>
</template>
