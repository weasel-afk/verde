local ChangeHistoryHelper = require(script.Parent.Parent.Shared.ChangeHistoryService)

return function(_payload)
	local canRedo, _operationName = ChangeHistoryHelper.GetCanRedo()
	if not canRedo then
		return false, "Nothing to redo"
	end

	ChangeHistoryHelper.Redo()
	return true
end
