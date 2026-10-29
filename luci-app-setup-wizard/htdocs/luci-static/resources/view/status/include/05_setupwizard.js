'use strict';
'require baseclass';
'require uci';

// Opens the setup wizard on the first visit to the overview page (the
// landing page after login) until the wizard is completed or dismissed.
// Renders nothing, so the overview looks unchanged.
return baseclass.extend({
	load: function() {
		var skipped = false;
		try { skipped = sessionStorage.getItem('setupwizard-skipped') == '1'; } catch (e) {}

		if (skipped)
			return Promise.resolve();

		return uci.load('setupwizard').then(function() {
			if (uci.get('setupwizard', 'state', 'done') != '1' &&
			    uci.get('setupwizard', 'state', 'dismissed') != '1')
				window.location = L.url('admin/system/setup-wizard');
		}).catch(function() {});
	},

	render: function() {
		return null;
	}
});
