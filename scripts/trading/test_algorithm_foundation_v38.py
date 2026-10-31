from datetime import datetime,timedelta
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import algorithm_foundation_v38 as f
import algorithm_memory_economics_v38 as e


class FoundationTests(unittest.TestCase):
    def test_explicit_july_cohort_leaves_prior_allowlists_unchanged(self):
        for d in f.DAYS:
            name,url=f.registered(d,"NEAR-USDT-SWAP","L2")
            self.assertIn(d,name);self.assertTrue(url.startswith("https://static.okx.com/"))
        for d in ("2026-08-19","2026-09-05","2026-11-01","2026-07-21"):
            with self.assertRaises(ValueError):f.registered(d,"NEAR-USDT-SWAP","L2")
        for call in (f.archives.registered,f.pilot.registered):
            with self.assertRaises(ValueError):call("2026-07-01","NEAR-USDT-SWAP","L2")
        with self.assertRaises(ValueError):f.registered("2026-07-01","BTC-USDT-SWAP","L2")

    def test_context_binds_day_symbol_and_complete_frozen_spec(self):
        a=f.context_sha("2026-07-01","NEAR-USDT-SWAP")
        self.assertNotEqual(a,f.context_sha("2026-07-02","NEAR-USDT-SWAP"))
        self.assertNotEqual(a,f.context_sha("2026-07-01","SOL-USDT-SWAP"))
        self.assertEqual(f.frozen_spec()["memory_minimum_prior_days"],20)
        self.assertFalse(f.frozen_spec()["independent_validation"])

    def test_dirty_pipeline_fails_before_source_guard_or_directory_creation(self):
        with tempfile.TemporaryDirectory() as td,patch.object(f,"clean_head",side_effect=ValueError), \
             patch.object(f,"source_guard") as guard:
            root=Path(td)/"new"
            with self.assertRaises(ValueError):f.run_batch(root,f.DAYS[0],Path(td),"wrong")
            guard.assert_not_called();self.assertFalse(root.exists())

    def test_manifest_change_fails_before_any_worktree_or_source_request(self):
        with tempfile.TemporaryDirectory() as td,patch.object(f.subprocess,"run") as run:
            p=Path(td);(p/"BTC-USDT-SWAP.manifest.json").write_text('{}')
            with self.assertRaises(ValueError):f.source_guard(p,p,p)
            run.assert_not_called()

    def test_spool_retirement_is_refused_without_successful_result(self):
        with tempfile.TemporaryDirectory() as td:
            root=Path(td);original,spool,url=f.file_paths(root,f.DAYS[0],f.SYMBOLS[0])
            original.parent.mkdir(parents=True);spool.parent.mkdir(parents=True)
            original.write_bytes(b'original');spool.write_bytes(b'irreplace-until-verified')
            Path(str(original)+'.receipt.json').write_text(json.dumps({'source_url':url}))
            feature=root/'features'/f'{f.SYMBOLS[0]}-{f.DAYS[0]}-restoration-v32.json'
            feature.parent.mkdir();feature.write_text('{}')
            index=root/'l2'/f.index_name(f.DAYS[0],f.SYMBOLS[0]);index.parent.mkdir();index.write_text('{}')
            with self.assertRaises(ValueError):f.retire_spool(root,f.DAYS[0],f.SYMBOLS[0])
            self.assertEqual(spool.read_bytes(),b'irreplace-until-verified')

    def test_verified_new_spool_can_be_rederived_from_retained_original(self):
        with tempfile.TemporaryDirectory() as td:
            root=Path(td);day,symbol=f.DAYS[0],f.SYMBOLS[0]
            original,spool,url=f.file_paths(root,day,symbol)
            original.parent.mkdir(parents=True);spool.parent.mkdir(parents=True)
            original.write_bytes(b'original');spool.write_bytes(b'derived')
            sha=f.archives.digest
            Path(str(original)+'.receipt.json').write_text(json.dumps({'source_url':url,'original_sha256':sha(original)}))
            idx=root/'l2'/f.index_name(day,symbol);idx.parent.mkdir();idx.write_text(json.dumps({'spool_sha256':sha(spool)}))
            feature=root/'features'/f'{symbol}-{day}-restoration-v32.json';feature.parent.mkdir()
            feature.write_text(json.dumps({'original_archive_sha':sha(original),'spool_sha':sha(spool),'index_sha':sha(idx)}))
            (root/'first-development-v38.json').write_text(json.dumps({'cases':[{'day':day,'symbol':symbol,'feature_sha':sha(feature)}]}))
            result=f.retire_spool(root,day,symbol)
            self.assertTrue(result['derived_spool_removed']);self.assertTrue(original.exists());self.assertTrue(feature.exists())
            self.assertTrue((root/f'{symbol}-spool-retirement-decision.json').exists())

    def test_missing_quotes_are_unknown_not_zero_payoff(self):
        c={'rows':[{'t':0,'sigma':1}], 'quotes':{}}
        self.assertNotIn('after_20bp_fee_bps',e.quoted(c,0,1))
        self.assertEqual(e.quoted(c,0,0)['after_20bp_fee_bps'],0)

    def test_drawdown_is_chronological_additive_diagnostic(self):
        self.assertEqual(e.additive_drawdown([10,-3,-4,1,-8]),14)
        self.assertEqual(e.additive_drawdown([]),0)

    def panels(self,n):
        out=[];first=datetime(2026,7,1)
        for i in range(n):
            for symbol in f.SYMBOLS:
                out.append({'day':(first+timedelta(days=i)).date().isoformat(),'symbol':symbol,
                    'available_decisions':100,'programs':{name:{'sum_quote_20bp':2 if name=='liquidity-payoff-memory' else 1,
                        'missing_quote_paths':0} for name in e.m.IDS}})
        return out

    def test_day_count_and_missing_labels_prevent_unearned_uncertainty_claim(self):
        self.assertEqual(e.moving_block_sensitivity(self.panels(19))['status'],'UNPOWERED_FEWER_THAN_20_DAYS')
        p=self.panels(20);p[0]['programs']['rank-flow']['missing_quote_paths']=1
        self.assertEqual(e.moving_block_sensitivity(p)['status'],'UNKNOWN_INCOMPLETE_COMMON_DAY_PANEL')

    def test_joint_day_bootstrap_is_reproducible_and_marks_assumptions(self):
        p=self.panels(20);a=e.moving_block_sensitivity(p);b=e.moving_block_sensitivity(p)
        self.assertEqual(a,b);self.assertEqual(a['multiple_comparisons'],6)
        self.assertEqual(a['paired_controls'],5)
        self.assertEqual(a['block_days'],3);self.assertFalse(a['stationarity_and_block_length_sufficiency_certified'])

    def test_calendar_gap_cannot_be_treated_as_adjacent_day_block(self):
        p=self.panels(20);p[-1]['day']='2026-10-01';p[-2]['day']='2026-10-01'
        self.assertEqual(e.moving_block_sensitivity(p)['status'],'UNPOWERED_NONCONTIGUOUS_DAY_BLOCKS')


if __name__=='__main__':unittest.main()
