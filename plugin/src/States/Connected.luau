local HttpService = game:GetService("HttpService")

local SharedFolder = require(script.Parent.Parent.Shared)

local SerializeDatamodel = require(script.Parent.Parent.SerializeDatamodel)
local isValidInstance = require(script.Parent.Parent.Utils.isValidInstance)
local WebSocketClient = require(script.Parent.Parent.WebSocketClient)
local InstanceMap = require(script.Parent.Parent.Shared.InstanceMap)
local Promise = require(script.Parent.Parent.Packages.Promise)
local PropertyTracker = SharedFolder.PropertyTracker
local ButtonInstance = SharedFolder.ButtonInstance
local Icons = SharedFolder.Icons
local State = SharedFolder.State
local Operations = require(script.Parent.Parent.Operations)
local SearchIndex = require(script.Parent.Parent.SearchIndex)
local Encoder = require(script.Parent.Parent.Tree.Encoder)

type Client = WebSocketClient.WebSocketClientInstance

local PROPERTIES_TO_WATCH = {
	"Name",
}

local MAX_FULL_SYNC_NODES = 50000

local connections: { RBXScriptConnection } = {}
local instanceConnections: { [string]: { RBXScriptConnection } } = {}
local snapshotPromise: any = nil
local deltaPromise: any = nil
local pendingOps: { any } = {}

local loadedParents: { [string]: true } = {}
local ROOT_PARENT_KEY = "__root__"
local fullSyncMode = false

local searchGraftedIds: { [string]: true } = {}
local lastSearchLower = ""
local lastSearchMatched: { Instance } = {}
local lastSearchTruncated = false
local searchCacheDirty = false
local searchGeneration = 0
local queuedSearchPromise: any = nil

local lastAckTime = 0
local initialSyncComplete = false

local function _resetSearchCache()
	lastSearchLower = ""
	lastSearchMatched = {}
	lastSearchTruncated = false
	searchCacheDirty = false
end

local function _disconnectInstance(id: string)
	local conns = instanceConnections[id]
	if not conns then
		return
	end

	for _, conn in conns do
		conn:Disconnect()
	end

	instanceConnections[id] = nil
end

local function _trackInstance(id: string, conn: RBXScriptConnection)
	local list = instanceConnections[id]
	if not list then
		list = {}
		instanceConnections[id] = list
	end

	table.insert(list, conn)
end

local function _parentDebugId(instance: Instance): string?
	local parent = instance.Parent
	if parent and parent ~= game then
		return parent:GetDebugId(0)
	end
	return nil
end

local function _encodeAndSend(client: Client, message: any): boolean
	if not client or not client.connected then
		return false
	end

	local jsonSuccess, jsonString = pcall(function()
		return HttpService:JSONEncode(message)
	end)

	if not jsonSuccess then
		warn("[verde] failed to encode message:", message.type, jsonString)
		return false
	end

	return client:send(jsonString) == true
end

local function _flushDelta(client: Client)
	if not client or not client.connected or #pendingOps == 0 then
		return
	end

	local addedRootIds: { string } = {}
	for _, op in pendingOps do
		if op.type == "add_subtree" and op.addedRootId then
			table.insert(addedRootIds, op.addedRootId)
		end
	end

	local message: any = {
		type = "explorer_delta",
		ops = pendingOps,
	}
	if #addedRootIds > 0 then
		message.addedRootIds = addedRootIds
	end

	local opsToSend = pendingOps
	pendingOps = {}

	local jsonSuccess, jsonString = pcall(function()
		return HttpService:JSONEncode(message)
	end)

	if not jsonSuccess then
		warn("[verde] failed to encode explorer_delta:", jsonString)
		pendingOps = opsToSend
		return
	end

	if not client:send(jsonString) then
		warn("[verde] failed to send explorer_delta (will retry)")
		pendingOps = opsToSend
		if not deltaPromise then
			deltaPromise = Promise.delay(0.1):andThen(function()
				deltaPromise = nil
				_flushDelta(client)
			end)
		end
	end
end

local function _pushOp(client: Client, op: any)
	table.insert(pendingOps, op)
	if deltaPromise then
		deltaPromise:cancel()
	end

	deltaPromise = Promise.delay(0.1):andThen(function()
		deltaPromise = nil
		_flushDelta(client)
	end)
end

local function _pushHasChildren(client: Client, id: string, hasChildren: boolean)
	_pushOp(client, {
		type = "update_node",
		timestamp = tick(),
		id = id,
		hasChildren = hasChildren,
	})
end

local function _listenToChanges(client: Client, descendant: Instance)
	local id = descendant:GetDebugId(0)

	for _, property in PROPERTIES_TO_WATCH do
		_trackInstance(
			id,
			descendant:GetPropertyChangedSignal(property):Connect(function()
				searchCacheDirty = true
				_pushOp(client, {
					type = "update_node",
					timestamp = tick(),
					id = id,
					name = descendant.Name,
				})
			end)
		)
	end

	if descendant:IsA("BaseScript") then
		for _, propName in ipairs({ "Enabled", "Disabled", "RunContext" }) do
			_trackInstance(
				id,
				descendant:GetPropertyChangedSignal(propName):Connect(function()
					local bs = descendant :: BaseScript
					_pushOp(client, {
						type = "update_node",
						timestamp = tick(),
						id = id,
						disabled = not bs.Enabled,
						runContext = bs.RunContext.Name,
					})
				end)
			)
		end
	end

	_trackInstance(
		id,
		descendant.AncestryChanged:Connect(function()
			searchCacheDirty = true
			local newParentId = _parentDebugId(descendant)
			_pushOp(client, {
				type = "move_node",
				timestamp = tick(),
				id = id,
				newParentId = newParentId,
			})
		end)
	)

	_trackInstance(
		id,
		descendant.ChildAdded:Connect(function(child)
			local function flagHasChildren()
				_pushHasChildren(client, id, true)
			end

			if not loadedParents[id] then
				flagHasChildren()
				return
			end

			local childId = child:GetDebugId(0)
			if instanceConnections[childId] or not isValidInstance(child) then
				flagHasChildren()
				return
			end

			local node = SerializeDatamodel.serializeShallow(child, id)
			InstanceMap[node.id] = child
			_listenToChanges(client, child)
			_pushOp(client, {
				type = "add_subtree",
				timestamp = tick(),
				parentId = id,
				rootId = node.id,
				nodes = { node },
			})
		end)
	)
	_trackInstance(
		id,
		descendant.ChildRemoved:Connect(function()
			_pushHasChildren(client, id, #descendant:GetChildren() > 0)
		end)
	)
end

local function _parentKey(instance: Instance): string?
	return _parentDebugId(instance) or ROOT_PARENT_KEY
end

local function _shouldSyncNewDescendant(descendant: Instance): boolean
	if fullSyncMode then
		return true
	end

	local key = _parentKey(descendant)
	return key ~= nil and loadedParents[key] == true
end

local function _sendSnapshotTooBig(client: Client)
	_encodeAndSend(client, { type = "snapshot_too_big" })
end

local function _sendSnapshot(client: Client, full: boolean?)
	if not client or not client.connected then
		print("sendSnapshot: not connected")
		return
	end

	local snapshot, instanceMap
	local searchBuildToken: number? = nil
	if full then
		local token = SearchIndex.beginBuild()
		searchBuildToken = token
		snapshot, instanceMap = SerializeDatamodel.serializeFull(MAX_FULL_SYNC_NODES, function(instance)
			SearchIndex.addVisitedInstance(token, instance)
		end)
		if not snapshot or not instanceMap then
			SearchIndex.cancelBuild(token)
			fullSyncMode = false
			_sendSnapshotTooBig(client)
			SearchIndex.rebuildAsync()
			return
		end
	else
		snapshot, instanceMap = SerializeDatamodel.serializeRoots()
	end

	if deltaPromise then
		deltaPromise:cancel()
		deltaPromise = nil
	end
	table.clear(pendingOps)

	-- Both full and partial (roots-only) snapshots reset the extension's tree to
	-- the nodes in this snapshot, and we disconnect every per-instance listener
	-- below regardless of `full`. Clear InstanceMap unconditionally so it stays
	-- consistent with that reset; otherwise a partial resend (e.g. the
	-- refreshExplorer full->partial fallback) would leak stale ids that point at
	-- now-unlistened instances.
	table.clear(InstanceMap)
	for id, _ in instanceConnections do
		_disconnectInstance(id)
	end
	for key, _ in loadedParents do
		loadedParents[key] = nil
	end
	table.clear(searchGraftedIds)
	_resetSearchCache()

	if full then
		fullSyncMode = true
		for id, _ in instanceMap do
			loadedParents[id] = true
		end
	else
		fullSyncMode = false
	end

	loadedParents[ROOT_PARENT_KEY] = true

	for id, instance in instanceMap do
		InstanceMap[id] = instance
		_listenToChanges(client, instance)
	end

	if
		not _encodeAndSend(client, {
			type = "explorer_snapshot",
			payload = snapshot,
			isFull = full == true,
		})
	then
		if searchBuildToken then
			SearchIndex.cancelBuild(searchBuildToken)
		end
		warn("[verde] failed to send explorer_snapshot (will retry)")
		if not snapshotPromise then
			snapshotPromise = Promise.delay(0.1):andThen(function()
				snapshotPromise = nil
				_sendSnapshot(client, full)
			end)
		end
		return
	end

	lastAckTime = tick()
	initialSyncComplete = true
	if searchBuildToken then
		SearchIndex.finishBuild(searchBuildToken)
	else
		SearchIndex.rebuildAsync()
	end
end

local function _sendOperationResult(
	client: Client,
	operationId: string,
	success: boolean,
	errorMessage: string?,
	data: any?
)
	local message = {
		type = "operation_result",
		operationId = operationId,
		result = {
			success = success,
			error = if success then nil else errorMessage,
			data = data,
		},
	}

	if not client or not client.connected then
		print("sendOperationResult: not connected")
		return
	end

	local jsonSuccess, jsonString = pcall(function()
		return HttpService:JSONEncode(message)
	end)

	if not jsonSuccess then
		print("sendOperationResult: failed to encode JSON:", jsonString)
		return
	end

	local sendSuccess = client:send(jsonString)

	if not sendSuccess then
		print("sendOperationResult: failed to send")
	end
end

local propertyUpdatePromise: any = nil
local getProperties = Operations.get_properties

local function _sendPropertyUpdate(client: Client, nodeId: string)
	if not client or not client.connected then
		return
	end

	if propertyUpdatePromise then
		propertyUpdatePromise:cancel()
	end

	propertyUpdatePromise = Promise.delay(0.1):andThen(function()
		propertyUpdatePromise = nil

		local propertiesResult = getProperties({ nodeId = nodeId })
		if not propertiesResult then
			return
		end

		_encodeAndSend(client, {
			type = "property_update",
			nodeId = nodeId,
			properties = propertiesResult,
		})
	end)
end

local function _handleOperation(client: Client, operationId: string, operation: any)
	if not operation or not operation.type then
		_sendOperationResult(client, operationId, false, "invalid_operation")
		return
	end

	local operationFunction = Operations[operation.type]

	if operationFunction then
		local result, errorMsg = operationFunction(operation)

		local success = result ~= nil and result ~= false
		local data = success and result
		local errorMessage = if success then nil else (errorMsg or "operation_failed")

		_sendOperationResult(client, operationId, success, errorMessage, data)
	else
		_sendOperationResult(client, operationId, false, "unknown_operation_type: " .. operation.type)
	end
end

local function _sendAck(client: Client, requestId: string?)
	lastAckTime = tick()

	local message = {
		type = "ack",
	}

	if requestId then
		message.requestId = requestId
	end

	_encodeAndSend(client, message)
end

local function _registerAndTrack(client: Client, id: string, instance: Instance)
	if not InstanceMap[id] then
		InstanceMap[id] = instance
	end
	if not instanceConnections[id] then
		_listenToChanges(client, instance)
	end
end

local function _releaseSearchGrafted(keep: { [string]: Instance }?)
	for id in searchGraftedIds do
		if keep and keep[id] then
			continue
		end
		if loadedParents[id] then
			searchGraftedIds[id] = nil
			continue
		end
		local instance = InstanceMap[id]
		if instance then
			local parentKey = _parentKey(instance)
			if parentKey and loadedParents[parentKey] then
				searchGraftedIds[id] = nil
				continue
			end
		end
		_disconnectInstance(id)
		searchGraftedIds[id] = nil
	end
end

local function _handleRequestSearch(client: Client, query: string?)
	if not client or not client.connected then
		return
	end

	searchGeneration += 1
	local generation = searchGeneration

	local trimmed = query and string.gsub(query, "^%s*(.-)%s*$", "%1") or ""
	if #trimmed < 2 then
		if queuedSearchPromise then
			queuedSearchPromise:cancel()
			queuedSearchPromise = nil
		end
		_releaseSearchGrafted(nil)
		_resetSearchCache()
		return
	end

	local lowercase = string.lower(trimmed)

	searchCacheDirty = false

	local function shouldCancel(): boolean
		return generation ~= searchGeneration or not client.connected
	end

	local function sendMatches(
		matches: { Instance },
		partial: boolean,
		searchTruncated: boolean,
		rebuildingIndex: boolean?
	)
		if shouldCancel() then
			return
		end

		local nodes, resultInstanceMap, nodeTruncated =
			SerializeDatamodel.serializeSearchMatches(matches)
		local truncated = searchTruncated or nodeTruncated

		if shouldCancel() then
			return
		end

		_releaseSearchGrafted(resultInstanceMap)
		for id, instance in resultInstanceMap do
			_registerAndTrack(client, id, instance)
			if not loadedParents[id] then
				searchGraftedIds[id] = true
			end
		end

		local message: any = {
			type = "search_result",
			query = trimmed,
			nodes = nodes,
			truncated = truncated,
			partial = partial,
		}
		if rebuildingIndex then
			message.rebuildingIndex = true
		end
		_encodeAndSend(client, message)
	end

	local function retryWhenIndexReady()
		if queuedSearchPromise then
			queuedSearchPromise:cancel()
		end
		queuedSearchPromise = Promise.delay(0.1):andThen(function()
			queuedSearchPromise = nil
			if generation ~= searchGeneration or not client.connected then
				return
			end
			if SearchIndex.isBuilding() then
				retryWhenIndexReady()
			else
				_handleRequestSearch(client, trimmed)
			end
		end)
	end

	if not SearchIndex.isReady() then
		if SearchIndex.isBuilding() then
			local partialMatched, partialTruncated, partialCanceled =
				SearchIndex.search(lowercase, shouldCancel, function(firstMatches, partialTruncated)
					sendMatches(firstMatches, true, partialTruncated, true)
				end)
			if partialCanceled or shouldCancel() then
				return
			end

			lastSearchLower = lowercase
			lastSearchMatched = partialMatched
			lastSearchTruncated = partialTruncated
			sendMatches(partialMatched, true, partialTruncated, true)
			retryWhenIndexReady()
			return
		end

		local nodes, resultInstanceMap, truncated, matched, canceled =
			SerializeDatamodel.serializeSearchResults(lowercase, nil, shouldCancel)

		if canceled or shouldCancel() then
			return
		end

		lastSearchLower = lowercase
		lastSearchMatched = matched
		lastSearchTruncated = truncated

		_releaseSearchGrafted(resultInstanceMap)
		for id, instance in resultInstanceMap do
			_registerAndTrack(client, id, instance)
			if not loadedParents[id] then
				searchGraftedIds[id] = true
			end
		end

		_encodeAndSend(client, {
			type = "search_result",
			query = trimmed,
			nodes = nodes,
			truncated = truncated,
			partial = false,
			rebuildingIndex = SearchIndex.isBuilding(),
		})
		return
	end

	local matched, truncated, canceled = SearchIndex.search(lowercase, shouldCancel, function(firstMatches, partialTruncated)
		sendMatches(firstMatches, true, partialTruncated)
	end)

	if canceled or shouldCancel() then
		return
	end

	lastSearchLower = lowercase
	lastSearchMatched = matched
	lastSearchTruncated = truncated

	sendMatches(matched, false, truncated)
end

local function _handleRequestChildren(client: Client, parentIds: { string })
	if not parentIds or #parentIds == 0 then
		return
	end

	for _, parentId in parentIds do
		local parentInstance = InstanceMap[parentId]
		if not parentInstance then
			continue
		end

		if loadedParents[parentId] then
			continue
		end

		local children, childInstanceMap = SerializeDatamodel.serializeChildren(parentInstance)
		for id, instance in childInstanceMap do
			_registerAndTrack(client, id, instance)
		end

		loadedParents[parentId] = true

		if #children == 0 then
			_pushHasChildren(client, parentId, false)
			continue
		end

		_pushOp(client, {
			type = "add_subtree",
			timestamp = tick(),
			parentId = parentId,
			rootId = children[1].id,
			nodes = children,
		})
	end
end

local function _handleReleaseSubtree(parentIds: { string }, nodeIds: { string })
	if fullSyncMode then
		return
	end

	local released: { [string]: true } = {}
	if parentIds then
		for _, parentId in parentIds do
			loadedParents[parentId] = nil
			released[parentId] = true
		end
	end

	if nodeIds then
		for _, id in nodeIds do
			_disconnectInstance(id)
			loadedParents[id] = nil
			searchGraftedIds[id] = nil
			released[id] = true
		end
	end

	if next(released) ~= nil and #pendingOps > 0 then
		local kept: { any } = {}
		for _, op in pendingOps do
			if op.type == "add_subtree" then
				local drop = (op.parentId ~= nil and released[op.parentId] == true)
					or (op.rootId ~= nil and released[op.rootId] == true)
				if not drop and op.nodes then
					for _, node in op.nodes do
						if node.id ~= nil and released[node.id] == true then
							drop = true
							break
						end
					end
				end
				if drop then
					continue
				end
			end
			table.insert(kept, op)
		end
		pendingOps = kept
	end
end

local _messageHandlers = {
	["operation"] = function(client: Client, data: any)
		_handleOperation(client, data.operationId, data.operation)
	end,
	["request_snapshot"] = function(client: Client, data: any)
		local full = data and data.full == true
		_sendSnapshot(client, full)
	end,
	["request_game_tree"] = function(client: Client, _data: any)
		-- The walk yields periodically, so it runs off the message thread;
		-- the result is pushed as a game_tree message (not an operation) so
		-- the extension is not bound by operation timeouts.
		task.spawn(function()
			local tree = Encoder.export(SharedFolder.PluginRoot.script)

			if not client.connected then
				return
			end

			if tree then
				_encodeAndSend(client, { type = "game_tree", payload = tree })
			else
				_encodeAndSend(client, { type = "game_tree_too_big" })
			end
		end)
	end,
	["request_children"] = function(client: Client, data: any)
		_handleRequestChildren(client, data.parentIds or {})
	end,
	["release_subtree"] = function(_client: Client, data: any)
		_handleReleaseSubtree(data and data.parentIds or {}, data and data.nodeIds or {})
	end,
	["request_search"] = function(client: Client, data: any)
		_handleRequestSearch(client, data and data.query)
	end,
	["ack"] = function(client: Client, data: any)
		_sendAck(client, data.requestId)
	end,
}

local connected = State.new()

connected.onEnter = function(transitionTo: (string) -> (), client: WebSocketClient.WebSocketClientInstance?)
	if not client then
		warn("[verde] no client provided")
		transitionTo("Disconnected")
		return
	end

	connected.client = client

	PropertyTracker.setUpdateCallback(function(nodeId: string)
		_sendPropertyUpdate(client, nodeId)
	end)

	client:on("message", function(data)
		if not data or not data.type then
			return
		end

		local handler = _messageHandlers[data.type]

		if handler then
			handler(client, data)
		end
	end)

	table.insert(
		connections,
		game.DescendantAdded:Connect(function(descendant)
			if not isValidInstance(descendant) then
				return
			end

			searchCacheDirty = true
			SearchIndex.addSubtree(descendant)

			if not _shouldSyncNewDescendant(descendant) then
				local parentId = _parentDebugId(descendant)
				if parentId and InstanceMap[parentId] then
					_pushHasChildren(client, parentId, true)
				end
				return
			end

			if instanceConnections[descendant:GetDebugId(0)] then
				return
			end

			local parentId = _parentDebugId(descendant)

			local node = SerializeDatamodel.serializeShallow(descendant, parentId)

			InstanceMap[node.id] = descendant
			_listenToChanges(client, descendant)

			local op: any = {
				type = "add_subtree",
				timestamp = tick(),
				parentId = parentId,
				rootId = node.id,
				nodes = { node },
			}
			if parentId == nil then
				op.addedRootId = node.id
			end
			_pushOp(client, op)
		end)
	)

	table.insert(
		connections,
		game.DescendantRemoving:Connect(function(descendant)
			local instanceId = descendant:GetDebugId(0)
			SearchIndex.removeSubtree(descendant)
			if not InstanceMap[instanceId] then
				return
			end

			searchCacheDirty = true

			InstanceMap[instanceId] = nil
			_disconnectInstance(instanceId)
			loadedParents[instanceId] = nil
			searchGraftedIds[instanceId] = nil

			_pushOp(client, {
				type = "remove_node",
				timestamp = tick(),
				id = instanceId,
			})
		end)
	)

	if ButtonInstance.button then
		ButtonInstance.button.Icon = Icons.CONNECTED
	end

	lastAckTime = tick()
	initialSyncComplete = false
	_sendSnapshot(client, false)
end

connected.onExit = function()
	if connected.client then
		connected.client:disconnect()
		connected.client = nil
	end

	-- Commit any pending operations before disconnecting
	local ChangeHistoryHelper = require(script.Parent.Parent.Shared.ChangeHistoryService)
	ChangeHistoryHelper.CommitPendingOperations()

	PropertyTracker.cleanupTracking()

	for _, connection in connections do
		connection:Disconnect()
	end

	for id, _ in instanceConnections do
		_disconnectInstance(id)
	end

	if snapshotPromise then
		snapshotPromise:cancel()
	end

	if deltaPromise then
		deltaPromise:cancel()
	end

	if propertyUpdatePromise then
		propertyUpdatePromise:cancel()
	end

	if queuedSearchPromise then
		queuedSearchPromise:cancel()
		queuedSearchPromise = nil
	end

	table.clear(connections)
	table.clear(pendingOps)
	table.clear(InstanceMap)
	for key, _ in loadedParents do
		loadedParents[key] = nil
	end
	table.clear(searchGraftedIds)
	_resetSearchCache()
	SearchIndex.clear()
	fullSyncMode = false
	lastAckTime = tick()
	initialSyncComplete = false
end

connected.onUpdate = function(dt, transitionTo: (string) -> ())
	if not initialSyncComplete then
		return
	end

	local now = tick()

	if now - lastAckTime > 5 then
		transitionTo("Disconnected")
		return
	end
end

return connected
