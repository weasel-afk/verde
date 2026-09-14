local PropertyTracker = require(script.Parent.Parent.Shared.PropertyTracker)

return function(_payload)
	PropertyTracker.cleanupTracking()
	return true
end
