'use strict';
'require view';

return view.extend({
	render: function() {
		return E('h2', {}, _('Setup Wizard'));
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
