<script setup>
import 'devdb-ui/style.css'
import './assets/base.css'
import './assets/style.css'
import { DevDB } from 'devdb-ui'
import { RouterView } from 'vue-router'
import { onMounted, onUnmounted, ref } from 'vue'

const vscode = ref()
const message = ref('')

const providers = ref([])
const connected = ref(false)
const tables = ref([])
const displayedTabs = ref([])
const activeTabIndex = ref()
const userPreferences = ref({})
const editSession = ref([])
const mcpServerConfig = ref([])
const itemsPerPage = ref(10)

onMounted(() => {
	vscode.value = acquireVsCodeApi()
	setupEventHandlers()
	vscode.value.postMessage({ type: 'request:get-user-preferences' })
	vscode.value.postMessage({ type: 'request:get-available-providers' })
	vscode.value.postMessage({ type: 'request:get-mcp-config' })
})

onUnmounted(() => {
	window.removeEventListener('message')
})

function setupEventHandlers() {
	window.addEventListener('message', event => {
		const payload = event.data

		switch (payload.type) {
			case 'response:get-mcp-config':
				mcpServerConfig.value = payload.value
				break

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
					connected.value = true
					vscode.value.postMessage({ type: 'request:get-tables' })
				}
				break

			case 'response:get-tables':
				if (isReconnection()) {
					notify('Reconnected')
				}

				tables.value = payload.value
				break

			case 'response:get-fresh-table-data':
				const tab = buildTabFromPayload(payload)
				if (!tab) return

				displayedTabs.value.push(tab)
				activeTabIndex.value = displayedTabs.value.length - 1
				break

			case 'response:get-refreshed-table-data':
			case 'response:load-table-into-current-tab':
				console.log({ 'refresh-response-payload': payload }) // TODO: ran into a situation where refreshing a tab didn't reflect latest db changes. remove this line when the issue is fixed
				const alternativeTab = buildTabFromPayload(payload)
				if (!alternativeTab) return

				displayedTabs.value.splice(activeTabIndex.value, 1, alternativeTab)
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

			case 'response:write-mutations':
				editSession.value = editSession.value.map(session => {
					if (session.tabId == payload.value.tabId) {
						session.outcome = payload.value.outcome
						session.errorMessage = payload.value.errorMessage

						if (session.outcome === 'success') {
							refreshTabById(payload) // also ensure changes from other tabs are reflected
						}
					}

					return session
				})

				break

			case 'response:reconnect':
				if (payload) {
					message.value = 'Reconnected'
				}
				break
		}
	})
}

function buildTabFromPayload(payload) {
	if (!payload.value) return

	const tab = {
		id: payload.value.id,
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
	connected.value = false
}

function reconnect() {
	vscode.value.postMessage({ type: 'request:reconnect' })
}

function isReconnection() {
	return tables.value.length || displayedTabs.value.length
}

// JSON strip this so we prevent "[object Object] could not be cloned" error
function removeProxyWrap(value) {
	return JSON.parse(JSON.stringify(value))
}

function getFreshTableData(table, itemsPerPage) {
	vscode.value.postMessage({ type: 'request:get-fresh-table-data', value: { table, itemsPerPage } })
}

function refreshActiveTab(activeTab) {
	vscode.value.postMessage({
		type: 'request:get-refreshed-table-data',
		value: {
			table: activeTab.table,
			itemsPerPage: activeTab.pagination.itemsPerPage,
		},
	})
}

function loadTableIntoCurrentTab(table) {
	if (activeTabIndex.value === undefined || activeTabIndex.value === null) {
		return getFreshTableData(table, itemsPerPage.value)
	}

	vscode.value.postMessage({
		type: 'request:load-table-into-current-tab',
		value: {
			table: table,
			itemsPerPage: itemsPerPage.value,
		},
	})
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
			columns: tab.columns,
			page,
			whereClause: tab.filters,
			totalRows: tab.totalRows,
			itemsPerPage: tab.pagination.itemsPerPage,
		},
	})
}

function exportTableData(exportData) {
	vscode.value.postMessage({
		type: 'request:export-table-data',
		value: removeProxyWrap(exportData),
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

function handleCellChanged(tabId, primaryKeyColumn, primaryKeyValue, columnName, newValue) {
	const tabIndex = displayedTabs.value.findIndex(tab => tab.id === tabId)

	if (tabIndex !== -1) {
		displayedTabs.value[tabIndex].rows = displayedTabs.value[tabIndex].rows.map(row => {
			if (row[primaryKeyColumn] === primaryKeyValue) {
				row[columnName] = newValue
			}

			return row
		})
	}
}

function commitToDatabase(serializedMutations) {
	if (!serializedMutations.length) return

	const tabId = serializedMutations[0].tabId

	editSession.value.push({
		tabId,
		mutations: serializedMutations.map(mutation => mutation.id),
		outcome: 'pending',
	})

	vscode.value.postMessage({ type: 'request:write-mutations', value: removeProxyWrap(serializedMutations) })
}

function refreshTabById(tabId) {
	const tabIndex = displayedTabs.value.findIndex(tab => tab.id === tabId)
	if (tabIndex === -1) {
		return
	}

	const tab = buildTabFromPayload(payload)
	displayedTabs.value.splice(tabIndex, 1, tab)
}

function handleMutationSessionCompleted(tabId) {
	editSession.value = editSession.value.filter(session => session.tabId !== tabId)
}

function handleRowDeleted(primaryKey, tabId) {
	const tabIndex = displayedTabs.value.findIndex(tab => tab.id === tabId)
	if (tabIndex === -1) return

	displayedTabs.value[tabIndex].rows = displayedTabs.value[tabIndex].rows.filter(row => row.id !== primaryKey)
}

function notify(title) {
	message.value = title

	setTimeout(() => {
		message.value = null
	}, 1500)
}
</script>

<template>
	 <!-- eslint-disable vue/no-multiple-template-root -->
	<div class="h-full min-h-full w-full min-w-full bg-white">
		 <!-- eslint-disable vue/valid-v-bind --> <DevDB
			:activeTabIndex
			:connected
			:editSession
			:providers
			:tables
			:tabs="displayedTabs"
			:userPreferences
			:message
			:mcpServerConfig
			@cell-value-changed="handleCellChanged"
			@commit-mutations="commitToDatabase"
			@destroy-ui="destroyUi"
			@reconnect="reconnect"
			@export-table-data="exportTableData"
			@get-data-for-tab-page="getDataForTabPage"
			@get-fresh-table-data="getFreshTableData"
			@items-per-page-changed="itemsPerPageChanged"
			@load-table-into-current-tab="loadTableIntoCurrentTab"
			@mutation-session-completed="handleMutationSessionCompleted"
			@open-settings="openSettings"
			@refresh-active-tab="refreshActiveTab"
			@refresh-providers="refreshProviders"
			@remove-tab="removeTab"
			@row-deleted="handleRowDeleted"
			@select-provider-option="selectProviderOption"
			@select-provider="selectProvider"
			@switch-to-tab="switchToTab"
			@update-current-tab-filter="getFilteredData"
		/>
	</div>
	 <RouterView />
</template>

