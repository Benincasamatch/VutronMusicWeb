<script setup lang="ts">
import RoomIcon from './RoomIcon.vue'
import { canRemoveWaitingEntry } from '@lan/shared'
import { useRoomStore } from '../stores/room'
import { formatTime } from '../utils/format'

const room = useRoomStore()
</script>

<template>
  <section id="queue" class="queue-section surface" aria-labelledby="queue-title">
    <div class="section-heading">
      <div>
        <p class="eyebrow">大家的选择</p>
        <h2 id="queue-title">播放队列 <span class="queue-count">{{ room.snapshot?.queue.entries.length ?? 0 }}</span></h2>
      </div>
      <RoomIcon name="queue" />
    </div>
    <p class="section-caption queue-caption">按点播顺序播放 · 所有人共享</p>
    <div v-if="!room.snapshot" class="empty-state"><p>正在确认待播队列…</p></div>
    <div v-else-if="!room.snapshot.queue.entries.length" class="empty-state queue-empty">
      <RoomIcon name="queue" />
      <h3>下一首，听你的</h3>
      <p>还没有待播歌曲。去点一首，让音乐继续。</p>
      <a class="text-link" href="#catalog">去点歌 <span aria-hidden="true">→</span></a>
    </div>
    <ol v-else class="waiting-list" aria-label="共享待播队列，可滚动查看" tabindex="0">
      <li v-for="(entry, index) in room.snapshot.queue.entries" :key="entry.entryId" class="waiting-row">
        <span class="queue-position" aria-hidden="true">{{ String(index + 1).padStart(2, '0') }}</span>
        <div class="track-info">
          <h3>{{ entry.track.title }}</h3>
          <p>{{ entry.track.artist ?? '艺术家未知' }} · {{ formatTime(entry.track.durationSeconds) }}</p>
          <p class="queue-requester">{{ entry.requester.username }}<span v-if="entry.requester.id === room.session?.user.id" class="own-label">我</span> 点播</p>
        </div>
        <button v-if="room.session && canRemoveWaitingEntry(room.session.user, entry)" class="button button-icon remove-button" type="button" :disabled="!room.canWrite" :aria-label="`移除第 ${index + 1} 首待播歌曲 ${entry.track.title}`" title="移出待播队列" @click="room.remove(entry.entryId)"><RoomIcon name="close" /></button>
      </li>
    </ol>
    <p class="section-footnote">{{ room.controlsAllowed ? '你可以移除任意待播歌曲。当前歌曲请使用播放控制切换。' : '只能移除自己尚未播放的歌曲，不能移除正在播放的歌曲。' }}</p>
  </section>
</template>
