<script setup lang="ts">
import RoomIcon from './RoomIcon.vue'
import { ref, watch } from 'vue'
import { LIMITS } from '@lan/shared'
import { useRoomStore } from '../stores/room'

const room = useRoomStore()
const query = ref(room.search)
watch(() => room.search, (value) => { query.value = value })
function search() {
  void room.loadCatalog(query.value, 0)
  window.location.hash = 'catalog'
}
</script>

<template>
  <form class="search-form" role="search" @submit.prevent="search">
    <label for="catalog-search" class="sr-only">搜索本地曲名</label>
    <RoomIcon name="search" />
    <input id="catalog-search" v-model="query" name="q" type="search" placeholder="搜索本地曲名" :maxlength="LIMITS.searchMaxLength" autocomplete="off" :disabled="!room.connected" />
    <button class="button" type="submit" :disabled="!room.connected || room.catalogLoading">搜索</button>
  </form>
</template>
