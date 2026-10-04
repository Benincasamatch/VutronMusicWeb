<script setup lang="ts">
import AccountManager from './components/AccountManager.vue'
import CatalogSearch from './components/CatalogSearch.vue'
import LoginPanel from './components/LoginPanel.vue'
import NowPlaying from './components/NowPlaying.vue'
import RoomIcon from './components/RoomIcon.vue'
import SharedQueue from './components/SharedQueue.vue'
import TrackCatalog from './components/TrackCatalog.vue'
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRoomStore } from './stores/room'
import { roleLabels } from './utils/format'

const room = useRoomStore()
const section = ref(window.location.hash || '#catalog')
const updateSection = () => { section.value = window.location.hash || '#catalog' }
const connectionLabel = computed(() => ({
  checking: '确认会话中',
  'signed-out': '尚未登录',
  connecting: '同步播放状态',
  connected: '已连接服务器',
  reconnecting: '连接中断 · 正在重连',
  offline: '无法连接服务器'
})[room.connection])

onMounted(() => {
  window.addEventListener('hashchange', updateSection)
  void room.start()
})
onBeforeUnmount(() => {
  window.removeEventListener('hashchange', updateSection)
  room.stop()
})
</script>

<template>
  <a class="skip-link" href="#main">跳到主要内容</a>
  <div class="app-shell" :class="{ 'has-session': room.session }">
    <header class="app-header">
      <a class="brand" href="#main" aria-label="VutronMusic 首页">
        <RoomIcon name="note" /><strong>VutronMusic</strong><span class="edition-label">LAN</span>
      </a>
      <div class="header-tools">
        <CatalogSearch v-if="room.session" />
        <div v-if="room.session" class="account-menu">
          <span class="avatar" aria-hidden="true">{{ room.session.user.username.slice(0, 1).toUpperCase() }}</span>
          <div class="account-label"><strong>{{ room.session.user.username }}</strong><small>{{ roleLabels[room.session.user.role] }}</small></div>
          <button class="button button-icon" type="button" aria-label="退出当前账号" title="退出当前账号" :disabled="room.authBusy" @click="room.logout()"><RoomIcon name="logout" /></button>
        </div>
        <span v-else class="header-caption">本地音乐 · 局域网遥控</span>
      </div>
    </header>

    <nav v-if="room.session" class="side-nav" aria-label="音乐导航">
      <a href="#catalog" :class="{ active: !['#queue', '#accounts'].includes(section) }" :aria-current="!['#queue', '#accounts'].includes(section) ? 'location' : undefined" aria-label="本地音乐" data-tip="本地音乐"><RoomIcon name="library" /></a>
      <a href="#queue" :class="{ active: section === '#queue' }" :aria-current="section === '#queue' ? 'location' : undefined" aria-label="播放队列" data-tip="播放队列"><RoomIcon name="queue" /></a>
      <a v-if="room.admin" href="#accounts" :class="{ active: section === '#accounts' }" :aria-current="section === '#accounts' ? 'location' : undefined" aria-label="账号管理" data-tip="账号管理"><RoomIcon name="users" /></a>
    </nav>

    <main id="main" tabindex="-1">
      <div v-if="room.snapshot?.simulation" class="simulation-banner" role="alert">
        <strong>模拟模式 · 不会实际发声</strong>
        <span>开发模拟驱动已启用；操作不会控制真实 mpv 或音频设备。</span>
      </div>
      <div v-if="room.notice" class="notice" :class="`notice-${room.notice.kind}`" :role="room.notice.kind === 'error' ? 'alert' : 'status'">
        <p>{{ room.notice.text }}</p>
        <button class="button button-icon" type="button" aria-label="关闭提示" @click="room.dismissNotice()"><RoomIcon name="close" /></button>
      </div>
      <template v-if="room.session">
        <div class="room-heading">
          <div><p class="eyebrow">音乐库 / LOCAL MUSIC</p><h1>本地音乐</h1><p class="library-description">你的音乐，大家一起听。</p></div>
          <div class="connection-status" role="status" :class="{ 'is-connected': room.connected }"><span class="status-dot" aria-hidden="true" />{{ connectionLabel }}</div>
        </div>
        <div v-if="!room.connected" class="connection-banner" role="status">
          <p>正在重新确认服务器状态。所有操作暂不可用，离线操作不会排队或自动重发。</p>
          <button class="button button-subtle" type="button" :disabled="room.authBusy" @click="room.reconnect()"><RoomIcon name="retry" />立即重连</button>
        </div>
        <div class="room-layout"><TrackCatalog /><SharedQueue /></div>
        <AccountManager v-if="room.admin" />
        <p class="library-footer">VutronMusic LAN · 仅浏览受控本地曲目，浏览器不播放音频。</p>
      </template>
      <LoginPanel v-else-if="room.connection === 'signed-out'" />
      <section v-else class="connecting-screen surface" aria-labelledby="connecting-title" :aria-busy="room.connection !== 'offline'">
        <RoomIcon name="note" /><h1 id="connecting-title">{{ connectionLabel }}</h1>
        <p class="muted">登录后同步服务器的音乐库与播放状态。</p>
        <button v-if="room.connection === 'offline'" class="button button-subtle" type="button" @click="room.reconnect()">重新连接</button>
      </section>
    </main>
    <NowPlaying v-if="room.session" />
    <footer v-else class="signed-out-footer">VutronMusic LAN <span>浏览器仅作遥控 · 不连接云音乐账号</span></footer>
  </div>
</template>
