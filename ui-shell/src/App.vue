<script setup>
import 'devdb-ui/style.css'
import './assets/base.css'
import './assets/style.css'
import { DevDB } from 'devdb-ui'
import { RouterView } from 'vue-router'
import GitHub from './components/GitHub.vue'
import { onMounted, onUnmounted, ref } from 'vue'

const vscode = ref()

const providers = ref([])
const tables = ref()
const displayedTables = ref({})
const activeTable = ref()
const filters = ref({})
const userPreferences = ref({})

const itemsPerPage = 10

onMounted(() => {
	vscode.value = acquireVsCodeApi()
	setupEventHandlers()
	vscode.value.postMessage({ type: 'request:get-user-preferences' })
	vscode.value.postMessage({ type: 'request:get-available-providers' })
})

onUnmounted(() => {
	window.removeEventListener('message')
})

function setupEventHandlers() {
	window.addEventListener('message', event => {
		const payload = event.data

		switch (payload.type) {
			case 'response:get-user-preferences':
				userPreferences.value = payload.value
				break

			case 'response:get-available-providers':
				providers.value = payload.value
				break

			case 'response:select-provider':
			case 'response:select-provider-option':
				const successfullySelected = payload.value
				if (successfullySelected) {
					vscode.value.postMessage({ type: 'request:get-tables' })
				}
				break

			case 'response:get-tables':
				tables.value = payload.value
				break

			case 'response:get-table-data':
				if (!payload.value) return
				const table = payload.value.table

				if (!displayedTables.value[table]) {
					displayedTables.value[table] = {}
				}

				displayedTables.value[table].tableCreationSql = payload.value.tableCreationSql
				displayedTables.value[table].lastQuery = payload.value.lastQuery
				displayedTables.value[table].columns = payload.value.columns
				displayedTables.value[table].rows = payload.value.rows
				displayedTables.value[table].totalRows = payload.value.totalRows
				displayedTables.value[table].pagination = payload.value.pagination
				break

			case 'response:get-data-for-page':
				if (!payload.value) return

				displayedTables.value[payload.value.table].lastQuery = payload.value.lastQuery
				displayedTables.value[payload.value.table].rows = payload.value.rows
				displayedTables.value[payload.value.table].pagination = payload.value.pagination
				break

			case 'ide-action:show-table-data':
				setActiveTable(payload.value)
				break

			case 'config-changed':
				userPreferences.value = payload.value
				break
		}
	})
}

function selectProvider(id) {
	vscode.value.postMessage({ type: 'request:select-provider', value: id })
}

function selectProviderOption(option) {
	vscode.value.postMessage({ type: 'request:select-provider-option', value: removeProxyWrap(option) })
}

function refreshProviders() {
	vscode.value.postMessage({ type: 'request:get-available-providers' })
}

function closeTable(table) {
	delete displayedTables.value[table]
}

function close() {
	tables.value = []
	displayedTables.value = {}
	activeTable.value = null
}

// JSON strip this so we prevent "[object Object] could not be cloned" error
function removeProxyWrap(value) {
	return JSON.parse(JSON.stringify(value))
}

function setActiveTable(table) {
	activeTable.value = table
}

function getTableData(table, itemsPerPage, whereClause) {
	whereClause = whereClause ? removeProxyWrap(whereClause) : null
	vscode.value.postMessage({ type: 'request:get-table-data', value: { table, itemsPerPage, whereClause } })
}

function getDataForPage(table, page, whereClause, totalRows, itemsPerPage) {
	whereClause = whereClause ? removeProxyWrap(whereClause) : null

	vscode.value.postMessage({
		type: 'request:get-data-for-page',
		value: {
			table,
			page,
			whereClause,
			totalRows,
			itemsPerPage,
		},
	})
}

function setFilter(tableFilters, table, itemsPerPage) {
	filters.value[table] = tableFilters
	const whereClause = removeProxyWrap(tableFilters)

	getTableData(table, itemsPerPage, whereClause)
}

function openSettings(theme) {
	vscode.value.postMessage({ type: 'request:open-settings', value: theme })
}
</script>

<template>
	<div class="h-full min-h-full w-full min-w-full bg-white">
		<DevDB
			:providers="providers"
			:tables="tables"
			:displayedTables="displayedTables"
			:activeTable="activeTable"
			:user-preferences="userPreferences"
			@close="close"
			@select-provider="selectProvider"
			@select-provider-option="selectProviderOption"
			@refresh-providers="refreshProviders"
			@set-active-table="setActiveTable"
			@get-table-data="getTableData"
			@filters="setFilter"
			@get-data-for-page="getDataForPage"
			@close-table="closeTable"
			@items-per-page-changed="value => (itemsPerPage = value)"
			@open-settings="openSettings"
		/>

		<div class="fixed bottom-1 right-8">
			<GitHub />
		</div>
	</div>
	<RouterView />
</template>
