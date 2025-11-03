import {Component, OnInit, inject, TransferState, makeStateKey} from '@angular/core';
import { HttpClient } from '@angular/common/http';
import {Observable, of, tap} from 'rxjs';
import {PLATFORM_ID} from "@angular/core";
import {DomSanitizer, platformBrowser, SafeHtml} from "@angular/platform-browser";

const TEST_KEY = makeStateKey<string>('testData');

@Component({
  selector: 'app-test',
  standalone: true,
  templateUrl: './test.component.html',
  imports: [
  ]
})
export class TestComponent implements OnInit {
  private http = inject(HttpClient);
  private platformId = inject(PLATFORM_ID); // ✅ inject it here
  private state = inject(TransferState);
  data?: SafeHtml|null = null;

  constructor(public sanitizer:DomSanitizer) {

  }

  ngOnInit() {
    this.loadData().subscribe(res => {
      this.data = this.sanitizer.bypassSecurityTrustHtml(res);
    });
  }

  loadData():Observable<any>{
    let response = this.state.get(TEST_KEY, null);
    if(response){
      this.state.remove(TEST_KEY);
      return of(response);
    }
    return this.http.get('/api/test', { responseType: 'json' })
      .pipe(tap((res:any)=>{
        this.state.set(TEST_KEY, res.html);
        return res;
    }));
  }
}
