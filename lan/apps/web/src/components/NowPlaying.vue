<script setup lang="ts">
import CommitSlider from './CommitSlider.vue'
import RoomIcon from './RoomIcon.vue'
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useRoomStore } from '../stores/room'
import { estimatedPosition, formatTime } from '../utils/format'

const room = useRoomStore()
const player = computed(() => room.snapshot?.player ?? null)
const identity = computed(() => `${room.snapshot?.serverInstanceId ?? ''}:${player.value?.playbackId ?? 'idle'}`)
const now = ref(performance.now())
let ticker: ReturnType<typeof setInterval> | undefined
const position = computed(() => player.value
  ? estimatedPosition(player.value, room.sampledAt, now.value, room.connected)
  : 0)
const transportDisabled = computed(() => !room.canWrite || !room.controlsAllowed || player.value?.status === 'loading')
const statusLabels = {
  idle: '等待播放',
  loading: '正在载入',
  playing: '正在播放',
  paused: '已暂停',
  error: '播放异常'
} as const

watch(() => room.connected && player.value?.status === 'playing', (playing) => {
  clearInterval(ticker)
  now.value = performance.now()
  if (playing) ticker = setInterval(() => { now.value = performance.now() }, 250)
}, { immediate: true })
watch(() => room.sampledAt, () => { now.value = performance.now() })
onBeforeUnmount(() => clearInterval(ticker))

function transport(command: 'play' | 'pause' | 'next' | 'previous') {
  if (player.value) void room.command({ command }, player.value.playbackId)
}

function seek(value: number, heldIdentity: string) {
  if (!player.value || heldIdentity !== identity.value) return
  void room.command({ command: 'seek', positionSeconds: value }, player.value.playbackId)
}

function volume(value: number, heldIdentity: string) {
  if (!player.value || heldIdentity !== identity.value) return
  void room.command({ command: 'volume', volume: Math.round(value) }, player.value.playbackId)
}

function mute() {
  if (player.value) void room.command({ command: 'mute', muted: !player.value.muted }, player.value.playbackId)
}
</script>

<template>
  <footer class="now-playing" aria-labelledby="playing-title" :aria-busy="room.busy !== null">
    <div class="playback-progress">
      <CommitSlider id="playback-seek" label="播放进度，松开后跳转" :value="player?.durationSeconds ? position : 0" :max="player?.durationSeconds || 1" :disabled="transportDisabled || !player?.current || !player.durationSeconds" :identity="identity" :describe="(value) => `${formatTime(value)}，总时长 ${formatTime(player?.durationSeconds ?? null)}`" @commit="seek" />
    </div>
    <p v-if="player?.error" class="inline-error player-error" role="alert">
      {{ player.error.code === 'PLAYER_UNAVAILABLE' ? '实体播放器暂不可用。' : '这次播放未能完成。' }} {{ player.error.message }}
    </p>
    <p v-if="player?.warning" class="inline-warning player-warning" role="status">
      {{ player.warning.code === 'AUDIO_DEVICE_FALLBACK' ? '实体播放器正在使用与配置不同的音频输出设备。' : '' }} {{ player.warning.message }}
    </p>
    <div class="current-track">
      <div class="track-emblem" aria-hidden="true"><RoomIcon name="note" /></div>
      <div class="current-track-copy">
        <h2 id="playing-title" :title="player?.current?.track.title">{{ player?.current?.track.title ?? '暂无播放歌曲' }}</h2>
        <p class="track-byline">{{ player?.current ? (player.current.track.artist ?? '艺术家未知') : '从本地音乐添加歌曲' }}<span v-if="player?.current" class="requester-line"> · {{ player.current.requester.username }} 点播</span></p>
        <span class="play-state" :class="{ 'is-playing': player?.status === 'playing' && room.connected }"><span class="status-dot" aria-hidden="true" />{{ !room.connected ? '等待同步 · 最后确认状态' : player ? statusLabels[player.status] : '读取状态' }}</span>
      </div>
    </div>
    <div class="player-center">
      <div v-if="room.controlsAllowed" class="transport" aria-label="实体播放器控制">
        <button class="button button-icon" type="button" aria-label="上一首；没有历史时从头播放" title="上一首；没有历史时从头播放" :disabled="transportDisabled" @click="transport('previous')"><RoomIcon name="previous" /></button>
        <button class="button button-icon play-button" type="button" :aria-label="player?.status === 'playing' ? '暂停' : player?.status === 'error' ? '重试播放' : '播放'" :title="player?.status === 'playing' ? '暂停' : player?.status === 'error' ? '重试播放' : '播放'" :disabled="transportDisabled || (!player?.current && !room.snapshot?.queue.entries.length)" @click="transport(player?.status === 'playing' ? 'pause' : 'play')"><RoomIcon :name="player?.status === 'playing' ? 'pause' : 'play'" /></button>
        <button class="button button-icon" type="button" aria-label="下一首" title="下一首" :disabled="transportDisabled || (!player?.current && !room.snapshot?.queue.entries.length)" @click="transport('next')"><RoomIcon name="next" /></button>
      </div>
      <p v-else class="listener-note">可点歌 · 播放由主持人控制</p>
    </div>
    <div class="player-right">
      <div class="volume-controls">
        <template v-if="player">
          <button class="button button-icon" type="button" :aria-label="player.muted ? '取消实体播放器静音' : '将实体播放器静音'" :title="player.muted ? '取消静音' : '静音'" :aria-pressed="player.muted" :disabled="!room.canWrite || !room.controlsAllowed" @click="mute"><RoomIcon :name="player.muted ? 'mute' : 'volume'" /></button>
          <CommitSlider id="player-volume" label="实体播放器音量" :value="player.volume" :max="100" :disabled="!room.canWrite || !room.controlsAllowed" :identity="identity" :describe="(value) => `${Math.round(value)}%${player?.muted ? '，已静音' : ''}`" @commit="volume" />
          <span class="volume-value">{{ player.muted ? '静音' : `${player.volume}%` }}</span>
        </template>
      </div>
      <a class="button button-icon" href="#queue" aria-label="查看播放队列" title="播放队列"><RoomIcon name="queue" /></a>
    </div>
  </footer>
</template>
