<script setup>
import 'devdb-ui/style.css'
import './assets/base.css'
import './assets/style.css'
import { DevDB } from 'devdb-ui'
import { RouterView } from 'vue-router'
import { onMounted, onUnmounted, ref } from 'vue'

const vscode = ref()

const providers = ref([])
const tables = ref([])
const displayedTabs = ref([])
const activeTabIndex = ref()
const userPreferences = ref({})

const itemsPerPage = ref(10)

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

			case 'response:get-fresh-table-data':
				const tab = buildTabFromPayload(payload)
				if (!tab) return

				displayedTabs.value.push(tab)
				activeTabIndex.value = displayedTabs.value.length - 1
				break

			case 'response:get-filtered-table-data':
				const updatedTab = buildTabFromPayload(payload)
				if (!updatedTab) return

				displayedTabs.value[activeTabIndex.value] = updatedTab
				break

			case 'response:get-data-for-tab-page':
				if (!payload.value) return

				displayedTabs.value[activeTabIndex.value].lastQuery = payload.value.lastQuery
				displayedTabs.value[activeTabIndex.value].rows = payload.value.rows
				displayedTabs.value[activeTabIndex.value].pagination = payload.value.pagination
				break

			case 'ide-action:show-table-data':
				getFreshTableData(payload.value, itemsPerPage.value)
				break

			case 'config-changed':
				userPreferences.value = payload.value
				break
		}
	})
}

function buildTabFromPayload(payload) {
	if (!payload.value) return

	const tab = {
		table: payload.value.table,
		filters: payload.value.filters || {},
		columns: payload.value.columns,
		rows: payload.value.rows,
		totalRows: payload.value.totalRows,
		pagination: payload.value.pagination,
		tableCreationSql: payload.value.tableCreationSql,
		lastQuery: payload.value.lastQuery,
	}

	return tab
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

function removeTab(tabIndex) {
	displayedTabs.value.splice(tabIndex, 1)
}

function destroyUi() {
	tables.value = []
	displayedTabs.value = []
}

// JSON strip this so we prevent "[object Object] could not be cloned" error
function removeProxyWrap(value) {
	return JSON.parse(JSON.stringify(value))
}

function getFreshTableData(table, itemsPerPage) {
	vscode.value.postMessage({ type: 'request:get-fresh-table-data', value: { table, itemsPerPage } })
}

function getFilteredData(filters, itemsPerPage) {
	if (activeTabIndex.value === undefined || activeTabIndex.value === null) return

	displayedTabs.value[activeTabIndex.value].filters = filters
	displayedTabs.value[activeTabIndex.value].itemsPerPage = itemsPerPage

	const tab = displayedTabs.value[activeTabIndex.value]

	updateCurrentTabFilter(tab.table, itemsPerPage, filters)
}

function updateCurrentTabFilter(table, itemsPerPage, filters) {
	filters = filters ? removeProxyWrap(filters) : null
	vscode.value.postMessage({ type: 'request:get-filtered-table-data', value: { table, itemsPerPage, filters } })
}

function switchToTab(tabIndex) {
	activeTabIndex.value = tabIndex
	const tab = displayedTabs.value[tabIndex]
	getDataForTabPage(tab, tab.pagination.currentPage)
}

function getDataForTabPage(tab, page) {
	tab = removeProxyWrap(tab)

	vscode.value.postMessage({
		type: 'request:get-data-for-tab-page',
		value: {
			table: tab.table,
			page,
			whereClause: tab.filters,
			totalRows: tab.totalRows,
			itemsPerPage: tab.pagination.itemsPerPage,
		},
	})
}

function itemsPerPageChanged(value) {
	if (activeTabIndex.value === undefined) return

	itemsPerPage.value = value
	const tab = displayedTabs.value[activeTabIndex.value]
	tab.pagination.itemsPerPage = value

	getDataForTabPage(tab, 1)
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
			:tabs="displayedTabs"
			:activeTabIndex="activeTabIndex"
			:user-preferences="userPreferences"
			@select-provider="selectProvider"
			@select-provider-option="selectProviderOption"
			@refresh-providers="refreshProviders"
			@get-fresh-table-data="getFreshTableData"
			@update-current-tab-filter="getFilteredData"
			@switch-to-tab="switchToTab"
			@get-data-for-tab-page="getDataForTabPage"
			@items-per-page-changed="itemsPerPageChanged"
			@open-settings="openSettings"
			@remove-tab="removeTab"
			@destroy-ui="destroyUi"
		/>
	</div>
	<RouterView />
</template>
