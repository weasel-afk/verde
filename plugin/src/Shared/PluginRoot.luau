--[[
	PluginRoot

	Holds a reference to the plugin's root script, set once at boot by
	the entry script, so exporters can skip the plugin's own tree.
]]

local PluginRoot = {
	script = nil :: Instance?,
}

return PluginRoot
