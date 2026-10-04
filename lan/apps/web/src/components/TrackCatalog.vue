<script setup lang="ts">
import RoomIcon from './RoomIcon.vue'
import { LIMITS } from '@lan/shared'
import { useRoomStore } from '../stores/room'
import { formatTime } from '../utils/format'

const room = useRoomStore()
</script>

<template>
  <section id="catalog" class="catalog-section" aria-labelledby="catalog-title">
    <div class="section-heading catalog-heading">
      <h2 id="catalog-title">{{ room.search ? '搜索结果' : '全部歌曲' }} <span class="queue-count">{{ room.totalTracks }}</span></h2>
      <span class="section-caption">{{ room.search ? `“${room.search}”` : '本地音乐库' }}</span>
    </div>
    <div class="track-columns" aria-hidden="true"><span>#</span><span>歌曲 / 艺术家</span><span>专辑</span><span>时长</span><span>点播</span></div>
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
          <div class="catalog-track">
            <span class="mini-cover" aria-hidden="true"><RoomIcon name="note" /></span>
            <div class="track-info"><h3>{{ track.title }}</h3><p>{{ track.artist ?? '艺术家未知' }}</p></div>
          </div>
          <span class="track-album">{{ track.album ?? '未知专辑' }}</span>
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
