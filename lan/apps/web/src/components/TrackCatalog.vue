<script setup lang="ts">
import RoomIcon from './RoomIcon.vue'
import { ref, watch } from 'vue'
import { LIMITS } from '@lan/shared'
import { useRoomStore } from '../stores/room'
import { formatTime } from '../utils/format'

const room = useRoomStore()
const query = ref(room.search)
watch(() => room.search, (value) => { query.value = value })

function search() {
  void room.loadCatalog(query.value, 0)
}
</script>

<template>
  <section id="catalog" class="catalog-section" aria-labelledby="catalog-title">
    <div class="section-heading">
      <div>
        <p class="eyebrow">从这里开始</p>
        <h2 id="catalog-title">点一首歌</h2>
      </div>
      <span class="section-caption">受控本地曲目</span>
    </div>
    <form class="search-form" role="search" @submit.prevent="search">
      <label for="catalog-search" class="sr-only">搜索本地曲名</label>
      <RoomIcon name="search" />
      <input id="catalog-search" v-model="query" name="q" type="search" placeholder="搜索本地曲名" :maxlength="LIMITS.searchMaxLength" autocomplete="off" :disabled="!room.connected" />
      <button class="button button-subtle" type="submit" :disabled="!room.connected || room.catalogLoading">搜索</button>
    </form>
    <div class="catalog-results" :aria-busy="room.catalogLoading">
      <p v-if="room.catalogLoading" class="loading-note" role="status">正在读取曲目…</p>
      <div v-else-if="room.catalogError" class="empty-state">
        <p class="inline-error" role="alert">{{ room.catalogError }}</p>
        <button class="button button-subtle" type="button" :disabled="!room.connected" @click="room.loadCatalog(room.search, room.catalogOffset)">重新读取</button>
      </div>
      <div v-else-if="!room.tracks.length" class="empty-state">
        <RoomIcon name="note" />
        <h3>{{ room.search ? '没有找到这首歌' : '本地曲目还未准备好' }}</h3>
        <p>{{ room.search ? '试试其他关键词，或清空搜索看看所有曲目。' : '请管理员在停服时将音频文件放入配置好的本地音乐目录，然后重启服务进行扫描。这里不提供文件上传。' }}</p>
        <button v-if="room.search" class="button button-subtle" type="button" :disabled="!room.connected" @click="room.loadCatalog('', 0)">查看全部曲目</button>
      </div>
      <ul v-else class="track-list" aria-label="可点播的本地曲目">
        <li v-for="(track, index) in room.tracks" :key="track.id" class="track-row">
          <span class="track-index" aria-hidden="true">{{ String(room.catalogOffset + index + 1).padStart(2, '0') }}</span>
          <div class="track-info">
            <h3>{{ track.title }}</h3>
            <p>{{ track.artist ?? '艺术家未知' }}<span v-if="track.album"> · {{ track.album }}</span></p>
          </div>
          <span class="track-duration" :aria-label="`时长 ${formatTime(track.durationSeconds)}`">{{ formatTime(track.durationSeconds) }}</span>
          <button class="button enqueue-button" type="button" :disabled="!room.canWrite || (room.snapshot?.queue.entries.length ?? 0) >= LIMITS.queueEntries" :aria-label="`点播 ${track.title}，加入共享待播队列`" @click="room.enqueue(track.id)">
            <RoomIcon name="plus" />
            <span>{{ room.busy === `enqueue:${track.id}` ? '提交中' : '点歌' }}</span>
          </button>
        </li>
      </ul>
    </div>
    <div v-if="room.totalTracks > 0 && !room.catalogError" class="pagination" aria-label="曲目分页">
      <span>共 {{ room.totalTracks }} 首<span v-if="room.search">匹配曲目</span></span>
      <div>
        <button class="button button-subtle" type="button" :disabled="!room.connected || room.catalogLoading || room.catalogOffset === 0" @click="room.loadCatalog(room.search, Math.max(0, room.catalogOffset - LIMITS.trackPageSize))">上一页</button>
        <span class="page-number" aria-label="当前页">{{ Math.floor(room.catalogOffset / LIMITS.trackPageSize) + 1 }}</span>
        <button class="button button-subtle" type="button" :disabled="!room.connected || room.catalogLoading || room.catalogOffset + LIMITS.trackPageSize >= room.totalTracks" @click="room.loadCatalog(room.search, room.catalogOffset + LIMITS.trackPageSize)">下一页</button>
      </div>
    </div>
    <p class="section-footnote">点歌只会加入待播队列，不会打断当前播放。</p>
  </section>
</template>
