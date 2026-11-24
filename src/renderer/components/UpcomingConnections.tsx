import { useAppStore } from '../store'
import BrandIcon from './BrandIcon'
import adjust from '../assets/brands/adjust.png'
import airbridge from '../assets/brands/airbridge.png'
import branch from '../assets/brands/branch.png'
import dfinery from '../assets/brands/dfinery.png'
import kochava from '../assets/brands/kochava.png'
import singular from '../assets/brands/singular.png'
import tenjin from '../assets/brands/tenjin.png'

const partners = [
  ['Adjust', adjust], ['Airbridge', airbridge], ['Branch', branch],
  ['DFINERY', dfinery], ['Kochava', kochava], ['Singular', singular], ['Tenjin', tenjin]
]

export function UpcomingGoogleAds() {
  const zh = useAppStore(s => s.language === 'zh')
  return <section className="flex items-center gap-3 rounded-2xl border border-line bg-ink-850 px-4 py-4">
    <BrandIcon brand="google" size={28} />
    <h3 className="text-[14px] font-semibold text-cream">Google Ads</h3>
    <span className="ml-auto text-[12px] text-cream-dim">{zh ? '功能即将上线' : 'Coming soon'}</span>
  </section>
}

export function UpcomingMeasurementPartners() {
  const zh = useAppStore(s => s.language === 'zh')
  return <section className="rounded-2xl border border-line bg-ink-850 p-4">
    <h3 className="mb-3 text-[14px] font-semibold text-cream">{zh ? '移动衡量合作伙伴' : 'Mobile measurement partners'}</h3>
    <ul className="grid gap-2 sm:grid-cols-2">{partners.map(([name, logo]) =>
      <li key={name} className="flex min-w-0 items-center gap-2 rounded-lg bg-overlay px-3 py-2.5">
        <img src={logo} alt="" width={24} height={24} className="h-6 w-6 object-contain" />
        <span className="text-[13px] font-medium">{name}</span>
        <span className="ml-auto text-[11px] text-cream-dim">{zh ? '即将上线' : 'Coming soon'}</span>
      </li>)}</ul>
  </section>
}
