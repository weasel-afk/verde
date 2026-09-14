local ChangeHistoryHelper = require(script.Parent.Parent.Shared.ChangeHistoryService)
local PropertyTracker = require(script.Parent.Parent.Shared.PropertyTracker)
local InstanceMap = require(script.Parent.Parent.Shared.InstanceMap)

return function(operation)
	local nodeId = operation.nodeId
	local attributeName = operation.attributeName

	local instance = InstanceMap[nodeId]

	if not instance then
		return false, "Instance not found"
	end

	if not attributeName or attributeName == "" then
		return false, "Attribute name is required"
	end

	local success, errorMessage = ChangeHistoryHelper.RecordOperation("RemoveAttribute", "Remove Attribute", function()
		instance:SetAttribute(attributeName, nil)
	end)

	if not success then
		return false, errorMessage
	end

	PropertyTracker.triggerUpdate(nodeId)

	return true
end
