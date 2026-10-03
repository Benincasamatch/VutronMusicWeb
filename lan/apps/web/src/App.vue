<script setup lang="ts">
import AccountManager from './components/AccountManager.vue'
import LoginPanel from './components/LoginPanel.vue'
import NowPlaying from './components/NowPlaying.vue'
import RoomIcon from './components/RoomIcon.vue'
import SharedQueue from './components/SharedQueue.vue'
import TrackCatalog from './components/TrackCatalog.vue'
import { computed, onBeforeUnmount, onMounted } from 'vue'
import { useRoomStore } from './stores/room'
import { roleLabels } from './utils/format'

const room = useRoomStore()
const connectionLabel = computed(() => ({
  checking: '确认会话中',
  'signed-out': '尚未登录',
  connecting: '同步播放状态',
  connected: '已连接听音室',
  reconnecting: '连接中断 · 正在重连',
  offline: '无法连接听音室'
})[room.connection])

onMounted(() => room.start())
onBeforeUnmount(() => room.stop())
</script>

<template>
  <a class="skip-link" href="#main">跳到主要内容</a>
  <div class="app-shell">
    <header class="app-header">
      <a class="brand" href="#main" aria-label="同一间，听音室首页">
        <span class="brand-mark" aria-hidden="true"><RoomIcon name="note" /></span>
        <span><strong>同一间</strong><small>局域网听音室</small></span>
      </a>
      <nav v-if="room.session" class="main-nav" aria-label="听音室导航">
        <a href="#catalog">点歌</a>
        <a href="#queue">待播队列</a>
        <a v-if="room.admin" href="#accounts">账号管理</a>
      </nav>
      <div v-if="room.session" class="account-menu">
        <div class="account-label"><strong>{{ room.session.user.username }}</strong><small>{{ roleLabels[room.session.user.role] }}</small></div>
        <button class="button button-icon" type="button" aria-label="退出当前账号" title="退出当前账号" :disabled="room.authBusy" @click="room.logout()"><RoomIcon name="logout" /></button>
      </div>
      <span v-else class="header-caption">音乐在房间里，不在屏幕里。</span>
    </header>

    <main id="main" tabindex="-1">
      <div v-if="room.snapshot?.simulation" class="simulation-banner" role="alert">
        <strong>模拟模式 · 不会实际发声</strong>
        <span>服务器正在使用显式开发模拟驱动，当前操作不会控制真实 mpv 或音频设备。</span>
      </div>
      <div v-if="room.notice" class="notice" :class="`notice-${room.notice.kind}`" :role="room.notice.kind === 'error' ? 'alert' : 'status'">
        <p>{{ room.notice.text }}</p>
        <button class="button button-icon" type="button" aria-label="关闭提示" @click="room.dismissNotice()"><RoomIcon name="close" /></button>
      </div>

      <template v-if="room.session">
        <div class="room-heading">
          <div><p class="eyebrow">把时间留给音乐</p><h1>今天，听点什么？</h1></div>
          <div class="connection-status" role="status" :class="{ 'is-connected': room.connected }">
            <span class="status-dot" aria-hidden="true" />{{ connectionLabel }}
          </div>
        </div>
        <div v-if="!room.connected" class="connection-banner" role="status">
          <p>正在重新确认服务器状态。所有操作暂不可用，离线操作不会排队或自动重发。</p>
          <button class="button button-subtle" type="button" :disabled="room.authBusy" @click="room.reconnect()"><RoomIcon name="retry" />立即重连</button>
        </div>
        <div class="room-layout">
          <div class="room-main"><NowPlaying /><TrackCatalog /></div>
          <SharedQueue />
        </div>
        <AccountManager v-if="room.admin" />
      </template>
      <LoginPanel v-else-if="room.connection === 'signed-out'" />
      <section v-else class="connecting-screen surface" aria-labelledby="connecting-title" :aria-busy="room.connection !== 'offline'">
        <RoomIcon name="note" />
        <h1 id="connecting-title">{{ connectionLabel }}</h1>
        <p class="muted">先确认身份，再同步同一台播放器的状态。</p>
        <button v-if="room.connection === 'offline'" class="button button-subtle" type="button" @click="room.reconnect()">重新连接</button>
      </section>
    </main>
    <footer class="app-footer"><span>同一间 · 共享点歌，实体播放</span><span>仅限受控本地曲目</span></footer>
  </div>
</template>
