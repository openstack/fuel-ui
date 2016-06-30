/*
 * Copyright 2015 Mirantis, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License"); you may
 * not use this file except in compliance with the License. You may obtain
 * a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS, WITHOUT
 * WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the
 * License for the specific language governing permissions and limitations
 * under the License.
 **/

define([
  'intern!object',
  'intern/chai!assert',
  'tests/functional/helpers',
  'tests/functional/pages/common',
  'tests/functional/pages/modal'
], function(registerSuite, assert, helpers, Common, Modal) {
  'use strict';

  registerSuite(function() {
    var common, modal;

    return {
      name: 'Wizard Page',
      setup: function() {
        common = new Common(this.remote);
        modal = new Modal(this.remote);
        return this.remote
          .then(function() {
            return common.getIn();
          });
      },
      beforeEach: function() {
        var clusterName = common.pickRandomName('Temp');
        return this.remote
          .clickByCssSelector('.create-cluster')
          .then(function() {
            return modal.waitToOpen();
          })
          .setInputValue('[name=name]', clusterName);
      },
      'Test create plugin with libvirt:rain, incompatible with xen': function() {
      // https://mirantis.testrail.com/index.php?/cases/view/842467

        return this.remote
          .pressKeys('\uE007')  // go to Compute

          // Enable xen, check that rain is disabled
          .clickByCssSelector('input[name=hypervisor\\:xen]')
          .assertElementDisabled('input[name=hypervisor\\:libvirt\\:rain]',
                                 'Rain checkbox is enabled with xen')

          // Disable xen, enable rain, check that xen is disabled
          .clickByCssSelector('input[name=hypervisor\\:xen]')
          .clickByCssSelector('input[name=hypervisor\\:libvirt\\:rain]')
          .assertElementDisabled('input[name=hypervisor\\:xen]',
                                 'Xen checkbox is enabled with rain')

          // Create cluster with rain hypervisor
          .pressKeys('\uE007')  // Networking
          .pressKeys('\uE007')  // Storage
          .pressKeys('\uE007')  // Additional Services
          .pressKeys('\uE007')  // Finish
          .pressKeys('\uE007')  // Create
          .then(function() {
            return modal.waitToOpen().sleep(50);
          })

          // Delete created environment
          .clickByCssSelector('button.delete-environment-btn')
          .clickByCssSelector('button.remove-cluster-btn');
      }
    };
  });
});
